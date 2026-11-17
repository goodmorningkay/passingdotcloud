#!/usr/bin/env python3
"""Deploy saved releases. Install this file as a root-owned executable."""

import contextlib
import fcntl
import hashlib
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid
from pathlib import Path, PurePosixPath

CONFIG = Path("/etc/passing-cloud/deploy.json")
SHA = re.compile(r"[0-9a-f]{40}\Z")
JOB = re.compile(r"[0-9a-f]{40}-[0-9a-f]{16}\Z")
SERVICES = ("web", "api", "proxy")
MAX_ARCHIVE = 64 * 1024 * 1024
NGINX_CONFIG = "/etc/nginx/nginx.conf"


class DeploymentError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise DeploymentError(message)


def read_json(path):
    return json.loads(path.read_text())


def has_saved_proxy_config(metadata):
    return (metadata / "proxy.json").is_file() and (metadata / "nginx.conf").is_file()


def require_complete_proxy_config(metadata):
    if (metadata / "proxy.json").exists() or (metadata / "nginx.conf").exists():
        require(
            has_saved_proxy_config(metadata),
            "The saved Nginx configuration is incomplete. Restore the missing snapshot file.",
        )


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + ".tmp")
    with open(temporary, "w", opener=lambda p, f: os.open(p, f, 0o600)) as stream:
        json.dump(value, stream)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def point(link, target):
    temporary = link.with_name(link.name + ".tmp")
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(target)
    temporary.replace(link)


def unpack(archive, destination):
    """Accept the regular files and directories produced by git archive."""
    with tarfile.open(archive, "r:") as source:
        members = source.getmembers()
        require(len(members) <= 20000, "The release has too many files.")
        names = set()
        total = 0
        for member in members:
            path = PurePosixPath(member.name)
            require(
                member.name and not path.is_absolute() and ".." not in path.parts,
                "The release has an unsafe path.",
            )
            require(
                member.isfile() or member.isdir(), "Release links are not permitted."
            )
            require(path not in names, "The release has a repeated path.")
            names.add(path)
            require(
                not any(
                    p in {".git", "node_modules", ".next", "data", ".test-data"}
                    for p in path.parts
                )
                and not any(
                    p.startswith(".env") and p != ".env.example" for p in path.parts
                )
                and path.parts[:2] not in {("ops", "private"), ("deploy", "certs")},
                "The release contains a private or generated file.",
            )
            total += member.size
            require(
                0 <= member.size <= MAX_ARCHIVE and total <= 256 * 1024 * 1024,
                "The expanded release is too large.",
            )
        for name in ("Dockerfile", "package.json", "package-lock.json"):
            require(PurePosixPath(name) in names, "The release is incomplete.")
        destination.mkdir(mode=0o755)
        for member in members:
            target = destination / member.name
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True, mode=0o755)
            else:
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
                with (
                    source.extractfile(member) as incoming,
                    target.open("xb") as outgoing,
                ):
                    shutil.copyfileobj(incoming, outgoing)
                target.chmod(0o755 if member.mode & 0o111 else 0o644)


class Deployer:
    def __init__(self, config=CONFIG):
        self.config_path = Path(config).resolve()
        self.config = read_json(self.config_path)
        self.root = Path(self.config["root"])
        self.releases = self.root / "releases"
        self.state = self.root / "deploy-state"
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.pending = self.state / "pending.json"

    @contextlib.contextmanager
    def lock(self, wait=False):
        with (self.state / "lock").open("a") as stream:
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | (0 if wait else fcntl.LOCK_NB))
            except BlockingIOError:
                raise DeploymentError(
                    "A server operation is still in progress."
                ) from None
            try:
                yield
            finally:
                fcntl.flock(stream, fcntl.LOCK_UN)

    def command(self, args, *, sha=None, capture=True, timeout=60, output=None):
        if output is None:
            output = subprocess.PIPE if capture else subprocess.DEVNULL
        try:
            result = subprocess.run(
                args,
                check=True,
                text=True,
                stdout=output,
                stderr=subprocess.DEVNULL,
                timeout=timeout,
                env={**os.environ, "PASSING_RELEASE": sha or ""},
            )
            return result.stdout or ""
        except (subprocess.SubprocessError, OSError):
            raise DeploymentError(
                "The server command failed. Check the deployment stage."
            ) from None

    def metadata(self, sha):
        return self.state / "releases" / sha

    def compose(self, source, metadata, sha, *args, capture=True, timeout=60):
        if args[:1] != ("stop",):
            require_complete_proxy_config(metadata)
        settings = read_json(metadata / "settings.json")
        command = [
            "docker",
            "compose",
            "--project-name",
            settings["project"],
            "--env-file",
            str(metadata / "environment"),
            "-f",
            str(source / settings["compose_file"]),
        ]
        for name in settings["overrides"]:
            command += ["-f", str(metadata / name)]
        if (metadata / "proxy.json").exists():
            command += ["-f", str(metadata / "proxy.json")]
        if (metadata / "images.json").exists():
            command += ["-f", str(metadata / "images.json")]
        return self.command(
            command + list(args), sha=sha, capture=capture, timeout=timeout
        )

    def snapshot(self, metadata):
        metadata.mkdir(parents=True, mode=0o700)
        settings = {key: self.config[key] for key in ("project", "compose_file")}
        settings["overrides"] = []
        for index, path in enumerate(self.config.get("overrides", [])):
            name = f"override-{index}.yaml"
            shutil.copyfile(path, metadata / name)
            (metadata / name).chmod(0o600)
            settings["overrides"].append(name)
        shutil.copyfile(self.config["env_file"], metadata / "environment")
        (metadata / "environment").chmod(0o600)
        write_json(metadata / "settings.json", settings)

    def use_saved_proxy_config(self, metadata, sha, bind_options=None):
        # The release directory protects this file on the host. Nginx needs read access.
        saved = metadata / "nginx.conf"
        saved.chmod(0o644)
        final_path = (self.metadata(sha) / saved.name).resolve()
        mount = {
            "type": "bind",
            "source": str(final_path).replace("$", "$$"),
            "target": NGINX_CONFIG,
            "read_only": True,
            "bind": {**(bind_options or {}), "create_host_path": False},
        }
        write_json(
            metadata / "proxy.json",
            {"services": {"proxy": {"volumes": [mount]}}},
        )

    def save_proxy_config(self, metadata, sha, rendered):
        for mount in rendered["services"]["proxy"].get("volumes", []):
            if mount["target"] != NGINX_CONFIG or mount["type"] != "bind":
                continue
            source = Path(mount["source"])
            require(source.is_file(), "The Nginx configuration file is absent.")
            saved = metadata / "nginx.conf"
            shutil.copyfile(source, saved)
            self.use_saved_proxy_config(metadata, sha, mount.get("bind"))
            # Check this copy before the staging directory moves to its final path.
            mount["source"] = str(saved.resolve())
            break

    def container(self, service):
        ids = self.command(
            [
                "docker",
                "ps",
                "-aq",
                "--filter",
                f"label=com.docker.compose.project={self.config['project']}",
                "--filter",
                f"label=com.docker.compose.service={service}",
            ]
        ).split()
        require(len(ids) == 1, "Expected one container for each production service.")
        return json.loads(self.command(["docker", "inspect", ids[0]]))[0]

    def running_proxy_with_bind(self):
        proxy = self.container("proxy")
        if any(
            mount["Destination"] == NGINX_CONFIG and mount["Type"] == "bind"
            for mount in proxy["Mounts"]
        ):
            return proxy["Id"]
        return None

    def save_running_proxy_config(self, metadata, sha):
        proxy = self.running_proxy_with_bind()
        if proxy:
            with tempfile.TemporaryDirectory(dir=metadata) as temporary:
                saved = Path(temporary) / "nginx.conf"
                with saved.open("xb") as output:
                    self.command(
                        ["docker", "exec", proxy, "cat", NGINX_CONFIG], output=output
                    )
                require(
                    saved.stat().st_size > 0, "The running Nginx configuration is empty."
                )
                saved.replace(metadata / saved.name)
            self.use_saved_proxy_config(metadata, sha)
        else:
            require(
                not (metadata / "proxy.json").exists(),
                "The running Nginx configuration mount is absent.",
            )

    def validate(self, source, metadata, sha):
        require(
            (source / self.config["compose_file"]).is_file(),
            "The Compose file is absent.",
        )
        rendered = json.loads(
            self.compose(source, metadata, sha, "config", "--format", "json")
        )
        api = rendered["services"]["api"]
        require(
            api["environment"]["PASSING_PUBLIC_ORIGIN"] == self.config["origin"],
            "The API origin does not match the production origin.",
        )
        require(
            not api.get("ports") and not rendered["services"]["web"].get("ports"),
            "The web and API ports must stay private.",
        )
        expected = self.config["data_mount"]
        mounts = [m for m in api.get("volumes", []) if m["target"] == "/app/data"]
        require(len(mounts) == 1, "Expected one transfer storage mount.")
        candidate = mounts[0]
        source_name = candidate["source"]
        if candidate["type"] == "volume":
            source_name = rendered["volumes"][source_name]["name"]
            self.command(["docker", "volume", "inspect", source_name])
        else:
            require(
                Path(source_name).is_dir(), "The transfer data directory is absent."
            )
        require(
            {"type": candidate["type"], "source": source_name} == expected,
            "The release would change transfer storage.",
        )
        running = [
            m
            for m in self.container("api")["Mounts"]
            if m["Destination"] == "/app/data"
        ]
        require(
            len(running) == 1
            and running[0]["Type"] == expected["type"]
            and (
                running[0].get("Name")
                if expected["type"] == "volume"
                else running[0]["Source"]
            )
            == expected["source"],
            "The running API does not use the recorded transfer storage.",
        )
        return rendered

    def save_images(self, metadata, sha, rendered, *, running=False):
        images = {}
        for service in SERVICES:
            reference = rendered["services"][service]["image"]
            if running:
                image_id = self.container(service)["Image"]
            else:
                image_id = json.loads(
                    self.command(["docker", "image", "inspect", reference])
                )[0]["Id"]
            images[service] = {"reference": reference, "id": image_id}
        write_json(metadata / "release.json", {"sha": sha, "images": images})
        write_json(
            metadata / "images.json",
            {
                "services": {
                    name: {"image": image["id"], "pull_policy": "never"}
                    for name, image in images.items()
                }
            },
        )

    def check_proxy(self, rendered):
        proxy = rendered["services"]["proxy"]
        command = [
            "docker",
            "run",
            "--rm",
            "--pull",
            "never",
            "--network",
            "none",
            "--read-only",
            "--log-driver",
            "none",
            "--cap-drop",
            "ALL",
            "--cap-add",
            "CHOWN",
            "--security-opt",
            "no-new-privileges:true",
            "--memory",
            "128m",
            "--pids-limit",
            "64",
            "--ulimit",
            "core=0",
            "--tmpfs",
            "/tmp",
            "--tmpfs",
            "/var/cache/nginx",
            "--tmpfs",
            "/var/run",
            "--add-host",
            "api:127.0.0.1",
            "--add-host",
            "web:127.0.0.1",
        ]
        for mount in proxy.get("volumes", []):
            kind, source = mount["type"], mount["source"]
            require(
                kind in {"bind", "volume"}, "The proxy mount type is not supported."
            )
            if kind == "volume":
                source = rendered["volumes"][source]["name"]
            command += [
                "--mount",
                f"type={kind},source={source},target={mount['target']},readonly",
            ]
        self.command(
            command + ["--entrypoint", "nginx", proxy["image"], "-t"], capture=False
        )

    def verify_images(self, sha, *, running=False):
        release = read_json(self.metadata(sha) / "release.json")
        for service, image in release["images"].items():
            self.command(["docker", "image", "inspect", image["id"]])
            if running:
                container = self.container(service)
                require(
                    container["Image"] == image["id"] and container["State"]["Running"],
                    "The running images do not match the release.",
                )
                if service in {"web", "api"}:
                    require(
                        container["State"].get("Health", {}).get("Status") == "healthy",
                        "A production container is not healthy.",
                    )

    def job_path(self, job):
        require(bool(JOB.fullmatch(job)), "Use a valid deployment ID.")
        return self.state / "jobs" / (job + ".json")

    def update(self, job, **values):
        path = self.job_path(job)
        record = read_json(path)
        record.update(values, updated_at=int(time.time()))
        write_json(path, record)
        return record

    def launch(self, job):
        self.command(
            [
                "systemd-run",
                "--quiet",
                "--collect",
                f"--unit=passing-cloud-deploy-{job}",
                "--property=Type=exec",
                "--property=RuntimeMaxSec=1800",
                "--property=StandardOutput=null",
                "--property=StandardError=null",
                "--property=UMask=0077",
                sys.executable,
                str(Path(__file__).resolve()),
                "--config",
                str(self.config_path),
                "worker",
                job,
            ]
        )

    def begin(
        self,
        sha,
        digest=None,
        incoming=None,
        *,
        expected_origin=None,
        recover=False,
        compatible=False,
    ):
        require(bool(SHA.fullmatch(sha)), "Use a full lowercase commit ID.")
        require(
            not recover or compatible,
            "Review database compatibility and pass --database-compatible.",
        )
        with self.lock():
            origin = read_json(self.config_path)["origin"]
            if expected_origin is not None:
                require(
                    expected_origin == origin.encode().hex(),
                    "The requested origin does not match the deployment server origin.",
                )
            require(
                not self.pending.exists(),
                "Resolve the pending deployment before starting another.",
            )
            if not recover:
                current = (self.root / "current").resolve()
                require(
                    current == (self.root / "last-successful").resolve(),
                    "Recover the unverified release before starting another deployment.",
                )
                metadata = self.metadata(current.name)
                require(
                    has_saved_proxy_config(metadata)
                    or (
                        not (metadata / "proxy.json").exists()
                        and not self.running_proxy_with_bind()
                    ),
                    "Run adopt to save the current Nginx configuration before deploying.",
                )
            if recover:
                metadata = self.metadata(sha)
                require(
                    (metadata / "release.json").is_file(),
                    "The saved release is absent.",
                )
                require_complete_proxy_config(metadata)
            job = sha + "-" + uuid.uuid4().hex[:16]
            archive = self.state / "incoming" / (job + ".tar")
            if not recover:
                require(
                    digest is not None and bool(re.fullmatch(r"[0-9a-f]{64}", digest)),
                    "Use a SHA-256 archive checksum.",
                )
                archive.parent.mkdir(mode=0o700, exist_ok=True)
                checksum = hashlib.sha256()
                total = 0

                def timed_out(signum, frame):
                    raise DeploymentError("The release upload timed out.")

                previous_handler = signal.signal(signal.SIGALRM, timed_out)
                signal.alarm(120)
                try:
                    with archive.open("xb") as output:
                        while block := incoming.read(1024 * 1024):
                            total += len(block)
                            require(
                                total <= MAX_ARCHIVE,
                                "The release archive is too large.",
                            )
                            checksum.update(block)
                            output.write(block)
                    require(
                        checksum.hexdigest() == digest,
                        "The release archive checksum does not match.",
                    )
                except Exception:
                    archive.unlink(missing_ok=True)
                    raise
                finally:
                    signal.alarm(0)
                    signal.signal(signal.SIGALRM, previous_handler)
            write_json(
                self.job_path(job),
                {
                    "id": job,
                    "sha": sha,
                    "mode": "recover" if recover else "deploy",
                    "phase": "queued",
                    "origin": origin,
                    "updated_at": int(time.time()),
                },
            )
            write_json(self.pending, {"id": job})
            try:
                self.launch(job)
            except DeploymentError:
                self.update(job, phase="failed", stage="launch")
                self.pending.unlink()
                archive.unlink(missing_ok=True)
                raise
            return {
                "id": job,
                "sha": sha,
                "phase": "queued",
                "origin": origin,
                **self.release_info(),
            }

    def worker(self, job):
        # The systemd worker can start before the launching command releases its lock.
        with self.lock(wait=True):
            record = read_json(self.job_path(job))
            require(
                read_json(self.pending)["id"] == job,
                "The deployment is no longer pending.",
            )
            sha = record["sha"]
            source, metadata = self.releases / sha, self.metadata(sha)
            staging = self.releases / (".prepare-" + job)
            settings = self.state / (".prepare-" + job)
            archive = self.state / "incoming" / (job + ".tar")
            switched = False
            stage = "preparation"
            try:
                origin = read_json(self.config_path)["origin"]
                require(
                    record.get("origin", origin) == origin,
                    "The production origin changed before activation.",
                )
                self.config["origin"] = origin
                self.update(job, phase="preparing", stage=stage)
                new_release = not (metadata / "release.json").exists()
                if new_release:
                    require(
                        shutil.disk_usage(self.root).free
                        >= self.config.get("build_free_bytes", 4_000_000_000),
                        "There is not enough free disk space for a build.",
                    )
                    require(
                        record["mode"] == "deploy"
                        and not source.exists()
                        and not metadata.exists(),
                        "The release directory has no saved image record.",
                    )
                    unpack(archive, staging)
                    self.snapshot(settings)
                    rendered = self.validate(staging, settings, sha)
                    self.save_proxy_config(settings, sha, rendered)
                    for service in ("web", "api"):
                        require(
                            rendered["services"][service]["image"].endswith(":" + sha),
                            "Application images must use the selected commit ID.",
                        )
                    stage = "build"
                    self.update(job, phase="building", stage=stage)
                    self.compose(
                        staging,
                        settings,
                        sha,
                        "build",
                        "web",
                        "api",
                        capture=False,
                        timeout=1500,
                    )
                    self.compose(
                        staging,
                        settings,
                        sha,
                        "pull",
                        "proxy",
                        capture=False,
                        timeout=180,
                    )
                    stage = "proxy configuration"
                    self.check_proxy(rendered)
                    self.save_images(settings, sha, rendered)
                    metadata.parent.mkdir(mode=0o700, exist_ok=True)
                    staging.rename(source)
                    settings.rename(metadata)
                rendered = self.validate(source, metadata, sha)
                self.verify_images(sha)
                if not new_release:
                    stage = "proxy configuration"
                    self.check_proxy(rendered)
                stage = "activation"
                self.update(job, phase="activating", stage=stage)
                point(self.root / "current", source)
                switched = True
                self.compose(
                    source,
                    metadata,
                    sha,
                    "up",
                    "-d",
                    "--no-build",
                    "--pull",
                    "never",
                    "--wait",
                    "--wait-timeout",
                    "120",
                    capture=False,
                    timeout=180,
                )
                self.compose(
                    source,
                    metadata,
                    sha,
                    "exec",
                    "-T",
                    "proxy",
                    "nginx",
                    "-t",
                    capture=False,
                )
                self.verify_images(sha, running=True)
                self.update(job, phase="awaiting-verification", stage="public HTTPS")
            except Exception as error:  # noqa: BLE001 - Record a safe result for every worker failure.
                self.update(
                    job,
                    phase="failed-after-switch" if switched else "failed",
                    stage=stage,
                    error=str(error)
                    if isinstance(error, DeploymentError)
                    else "The deployment failed.",
                )
                if not switched:
                    self.pending.unlink(missing_ok=True)
            finally:
                archive.unlink(missing_ok=True)
                for path in (staging, settings):
                    if path.exists():
                        shutil.rmtree(path)

    def status(self, job):
        record = read_json(self.job_path(job))
        active = self.command(
            [
                "systemctl",
                "show",
                f"passing-cloud-deploy-{job}",
                "--property=ActiveState",
                "--value",
            ]
        ).strip()
        record["worker_active"] = active in {
            "activating",
            "active",
            "reloading",
            "deactivating",
        }
        record.update(self.release_info())
        return record

    def release_info(self):
        result = {}
        for name in ("current", "previous", "last-successful"):
            link = self.root / name
            result[name.replace("-", "_")] = (
                link.resolve().name if link.exists() else None
            )
        current = result["current"]
        if current and (self.metadata(current) / "release.json").exists():
            result["images"] = read_json(self.metadata(current) / "release.json")[
                "images"
            ]
        return result

    def info(self):
        result = self.release_info()
        result["origin"] = self.config["origin"]
        result["pending"] = (
            read_json(self.pending)["id"] if self.pending.exists() else None
        )
        return result

    def finish(self, job, result):
        require(result in {"success", "failure"}, "Use success or failure.")
        with self.lock():
            require(
                self.pending.exists() and read_json(self.pending)["id"] == job,
                "The deployment is no longer pending.",
            )
            record = read_json(self.job_path(job))
            if result == "success":
                require(
                    record["phase"] == "awaiting-verification",
                    "The release is not ready for verification.",
                )
                require(
                    (self.root / "current").resolve() == self.releases / record["sha"],
                    "The active release changed during verification.",
                )
                self.verify_images(record["sha"], running=True)
                last = self.root / "last-successful"
                if (
                    last.exists()
                    and last.resolve() != (self.root / "current").resolve()
                ):
                    point(self.root / "previous", last.resolve())
                point(last, (self.root / "current").resolve())
            else:
                require(
                    not self.status(job)["worker_active"],
                    "The server worker is still active.",
                )
            self.pending.unlink()
            record = self.update(
                job, phase="succeeded" if result == "success" else "verification-failed"
            )
            return {**record, **self.release_info()}

    def adopt(self):
        with self.lock():
            require(
                not self.pending.exists(),
                "Resolve the pending deployment before adopting a release.",
            )
            source = (self.root / "current").resolve()
            sha = source.name
            require(
                bool(SHA.fullmatch(sha)), "The current release has no full commit ID."
            )
            metadata = self.metadata(sha)
            if (metadata / "release.json").is_file():
                require(
                    source == (self.root / "last-successful").resolve(),
                    "Only the current successful release can be adopted again.",
                )
                self.verify_images(sha, running=True)
                if not has_saved_proxy_config(metadata):
                    self.save_running_proxy_config(metadata, sha)
                return {"sha": sha, "phase": "adopted"}
            require(
                not metadata.exists(),
                "The current release already has an image record.",
            )
            try:
                self.snapshot(metadata)
                rendered = self.validate(source, metadata, sha)
                self.save_running_proxy_config(metadata, sha)
                self.save_images(metadata, sha, rendered, running=True)
                self.verify_images(sha, running=True)
                point(self.root / "last-successful", source)
            except Exception:
                if metadata.exists():
                    shutil.rmtree(metadata)
                raise
            return {"sha": sha, "phase": "adopted"}

    def boot(self, stop=False):
        with self.lock():
            sha = (self.root / "current").resolve().name
            require(
                bool(SHA.fullmatch(sha)), "The current release has no full commit ID."
            )
            if stop:
                args = ["stop"]
            else:
                self.verify_images(sha)
                args = [
                    "up",
                    "-d",
                    "--no-build",
                    "--pull",
                    "never",
                    "--wait",
                    "--wait-timeout",
                    "120",
                ]
            self.compose(
                self.releases / sha,
                self.metadata(sha),
                sha,
                *args,
                capture=False,
                timeout=180,
            )
            return {"sha": sha, "phase": "stopped" if stop else "started"}


def main(arguments):
    config = CONFIG
    if arguments[:1] == ["--config"]:
        require(len(arguments) >= 3, "Specify a configuration file and command.")
        config, arguments = Path(arguments[1]), arguments[2:]
    deployer = Deployer(config)
    ssh = arguments[:1] == ["ssh"]
    if ssh:
        require(len(arguments) == 2, "Expected one SSH command.")
        arguments = shlex.split(arguments[1])
    require(
        bool(arguments), "Use deploy, status, finish, recover, adopt, boot, or stop."
    )
    action, *args = arguments
    if action == "info" and not args:
        return deployer.info()
    if action == "deploy":
        require(
            len(args) == 3 or (not ssh and len(args) == 2),
            "Send the commit ID, archive checksum, and expected origin.",
        )
        return deployer.begin(
            *args[:2],
            incoming=sys.stdin.buffer,
            expected_origin=args[2] if len(args) == 3 else None,
        )
    if action == "status" and len(args) == 1:
        return deployer.status(*args)
    if action == "finish" and len(args) == 2:
        return deployer.finish(*args)
    if action == "recover" and len(args) == 2 and args[1] == "--database-compatible":
        return deployer.begin(args[0], recover=True, compatible=True)
    require(not ssh, "This command is not permitted through the deployment key.")
    if action == "worker" and len(args) == 1:
        deployer.worker(*args)
        return {"id": args[0]}
    if action == "adopt" and not args:
        return deployer.adopt()
    if action in {"boot", "stop"} and not args:
        return deployer.boot(stop=action == "stop")
    raise DeploymentError("The command or its arguments are not valid.")


if __name__ == "__main__":
    os.umask(0o077)
    try:
        print(json.dumps(main(sys.argv[1:])))
    except Exception as error:  # noqa: BLE001 - Never print unexpected exception details or secrets.
        print(
            json.dumps(
                {
                    "error": str(error)
                    if isinstance(error, DeploymentError)
                    else "The server operation failed."
                }
            ),
            file=sys.stderr,
        )
        sys.exit(1)
