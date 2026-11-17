"""Rehearse container replacement and recovery with separate, disposable storage."""

import hashlib
import importlib.util
import io
import ipaddress
import json
import os
import shutil
import socket
import subprocess
import tempfile
import urllib.error
import urllib.request
import uuid
from pathlib import Path

repo = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location(
    "deploy", repo / "scripts/deploy-release.py"
)
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
base = Path(tempfile.mkdtemp(prefix="passing-deployment-rehearsal-"))
project = "passing-rehearsal-" + uuid.uuid4().hex[:8]
old, new = "a" * 40, "b" * 40
with socket.socket() as reservation:
    reservation.bind(("127.0.0.1", 0))
    port = reservation.getsockname()[1]
origin = f"http://127.0.0.1:{port}"
subnet = ipaddress.ip_network(
    os.environ.get("PASSING_REHEARSAL_SUBNET", "172.31.86.0/28")
)
assert subnet.version == 4 and subnet.prefixlen == 28
root = base / "app"
releases = root / "releases"
releases.mkdir(parents=True)
sockets = base / "sockets"
sockets.mkdir()
environment = base / "environment"
nginx = base / "nginx.conf"
os.environ.pop("PASSING_PUBLIC_ORIGIN", None)
os.environ.pop("PASSING_NGINX_CONFIG", None)
environment.write_text(
    f"PASSING_PUBLIC_ORIGIN={origin}\nPASSING_NGINX_CONFIG={nginx}\nPASSING_ADMIN_KEY=\n"
)
nginx.write_text("""user nginx;
events { worker_connections 128; }
error_log /dev/null crit;
http {
 access_log off;
 client_max_body_size 101m;
 server {
  listen 80;
  add_header X-Rehearsal-Proxy original;
  location /api/ {
   proxy_pass http://api:4000;
   proxy_set_header Host 127.0.0.1;
   proxy_set_header X-Forwarded-Proto http;
   proxy_set_header X-Forwarded-For $remote_addr;
   proxy_request_buffering off;
   proxy_buffering off;
  }
  location / { proxy_pass http://web:3000; }
 }
}
""")
overlay = base / "override.json"
deploy.write_json(
    overlay,
    {
        "services": {
            "web": {
                "image": project + "-web:${PASSING_RELEASE}",
                "build": {"network": "default"},
                "healthcheck": {"interval": "2s", "start_period": "5s"},
                "networks": {"backend": {"ipv4_address": str(subnet[4])}},
            },
            "api": {
                "image": project + "-api:${PASSING_RELEASE}",
                "build": {"network": "default"},
                "healthcheck": {"interval": "2s", "start_period": "5s"},
                "networks": {"backend": {"ipv4_address": str(subnet[3])}},
                "environment": {
                    "NODE_ENV": "development",
                    "PASSING_TRUST_PROXY": str(subnet[2]),
                },
            },
            "proxy": {
                "ports": [f"127.0.0.1:{port}:80"],
                "networks": {"backend": {"ipv4_address": str(subnet[2])}},
                "volumes": [
                    f"{sockets}:/run/passing-cloud-test",
                ],
            },
        },
        "networks": {
            "backend": {
                "internal": False,
                "driver_opts": {
                    "com.docker.network.bridge.name": "br-pc-" + uuid.uuid4().hex[:8]
                },
                "ipam": {"config": [{"subnet": str(subnet)}]},
            }
        },
    },
)
config = base / "config.json"
deploy.write_json(
    config,
    {
        "root": str(root),
        "project": project,
        "compose_file": "compose.caddy.yaml",
        "overrides": [str(overlay)],
        "env_file": str(environment),
        "origin": origin,
        "data_mount": {"type": "volume", "source": project + "_transfers"},
        "build_free_bytes": 0,
    },
)
payload = subprocess.check_output(["git", "archive", "--format=tar", "HEAD"], cwd=repo)
checksum = hashlib.sha256(payload).hexdigest()
archive_path = base / "source.tar"
archive_path.write_bytes(payload)
deploy.unpack(archive_path, releases / old)
deploy.point(root / "current", releases / old)
prefix = [
    "docker",
    "compose",
    "--project-name",
    project,
    "--env-file",
    str(environment),
    "-f",
    str(releases / old / "compose.caddy.yaml"),
    "-f",
    str(overlay),
]
env = {**os.environ, "PASSING_RELEASE": old}
log = (base / "docker.log").open("w")


def command(args):
    subprocess.run(args, env=env, stdout=log, stderr=log, check=True)


def request(route, method="GET", body=None, token=None):
    headers = {"Origin": origin}
    if body is not None:
        headers["Content-Type"] = (
            "application/octet-stream"
            if isinstance(body, bytes)
            else "application/json"
        )
    if token:
        headers["Authorization"] = "Bearer " + token
    encoded = (
        body if isinstance(body, bytes) else json.dumps(body).encode() if body else None
    )
    return urllib.request.urlopen(
        urllib.request.Request(
            origin + route, data=encoded, headers=headers, method=method
        ),
        timeout=15,
    )


class Rehearsal(deploy.Deployer):
    def __init__(self, path):
        super().__init__(path)
        self.builds = 0

    def launch(self, job):
        pass

    def command(self, args, **options):
        if args[0] == "systemctl":
            return "inactive\n"
        if "build" in args:
            self.builds += 1
        return super().command(args, **options)


try:
    print("Building and starting isolated web, API, and proxy containers.", flush=True)
    command(prefix + ["build", "web", "api"])
    command(prefix + ["pull", "proxy"])
    command(prefix + ["up", "-d", "--no-build", "--wait", "--wait-timeout", "120"])
    for service in ("web", "api"):
        command(prefix + ["exec", "-T", service, "test", "-r", "/app/LICENSE"])
    host = Rehearsal(config)
    original_config = nginx.read_text()
    candidate_config = original_config.replace("original", "candidate")
    replacement = base / "nginx-replacement.conf"
    replacement.write_text(candidate_config)
    replacement.replace(nginx)
    candidate = base / "nginx-candidate.conf"
    candidate.write_text(candidate_config)
    environment.write_text(environment.read_text().replace(str(nginx), str(candidate)))
    host.adopt()
    saved = host.metadata(old)
    assert (saved / "nginx.conf").read_text() == original_config

    def begin_candidate():
        return host.begin(
            new, checksum, io.BytesIO(payload), expected_origin=origin.encode().hex()
        )["id"]

    def repair_proxy_snapshot():
        try:
            begin_candidate()
        except deploy.DeploymentError as error:
            assert "Run adopt" in str(error)
        else:
            raise RuntimeError("The release could be replaced without a saved proxy.")
        host.adopt()
        assert (saved / "nginx.conf").read_text() == original_config

    def check_incomplete_proxy_snapshot(action):
        override = saved / "proxy.json"
        backup = saved / "proxy.json.backup"
        override.rename(backup)
        try:
            action()
        except deploy.DeploymentError as error:
            assert "configuration is incomplete" in str(error)
        else:
            raise RuntimeError("The release started without its saved proxy override.")
        finally:
            backup.replace(override)

    # Check an older release record, then one that has lost only the Nginx file.
    (saved / "proxy.json").unlink()
    (saved / "nginx.conf").unlink()
    repair_proxy_snapshot()
    (saved / "nginx.conf").unlink()
    repair_proxy_snapshot()

    with request("/") as response:
        assert response.headers["X-Rehearsal-Proxy"] == "original"
    test_bytes = os.urandom(1024)
    created = json.load(
        request(
            "/api/transfers",
            "POST",
            {"size": 0, "encryptedSize": len(test_bytes), "ttlSeconds": 3600},
        )
    )
    route = "/api/transfers/" + created["id"]
    request(route + "/content", "PUT", test_bytes, created["uploadToken"]).close()
    print(
        "Deploying a new release with the same isolated transfer storage.", flush=True
    )
    candidate.write_text("invalid_rehearsal_directive;\n")
    rejected = begin_candidate()
    host.worker(rejected)
    status = host.status(rejected)
    assert (status["phase"], status["stage"]) == ("failed", "proxy configuration")
    assert host.info()["current"] == old
    assert not host.metadata(new).exists()
    candidate.write_text(candidate_config)

    job = begin_candidate()
    host.worker(job)
    status = host.status(job)
    if status["phase"] != "awaiting-verification":
        raise RuntimeError(json.dumps(status))
    assert status["origin"] == origin
    with request("/") as response:
        assert response.headers["X-Rehearsal-Proxy"] == "candidate"
    assert request(route + "/content").read() == test_bytes
    assert host.info()["last_successful"] == old
    host.finish(job, "failure")
    builds = host.builds
    print("Recovering saved images after a simulated public-check failure.", flush=True)
    check_incomplete_proxy_snapshot(
        lambda: host.begin(old, recover=True, compatible=True)
    )
    assert host.info()["pending"] is None
    assert host.info()["current"] == new
    recovery = host.begin(old, recover=True, compatible=True)["id"]
    host.worker(recovery)
    status = host.status(recovery)
    if status["phase"] != "awaiting-verification":
        raise RuntimeError(json.dumps(status))
    assert host.builds == builds
    assert request(route + "/content").read() == test_bytes
    with request("/") as response:
        assert response.headers["X-Rehearsal-Proxy"] == "original"
    assert json.load(request("/api/health")) == {"ok": True}
    host.finish(recovery, "success")
    assert host.info()["current"] == old
    check_incomplete_proxy_snapshot(host.boot)
    request(route, "DELETE", token=created["deleteToken"]).close()
    for target in [route, route + "/content"]:
        try:
            request(target).close()
        except urllib.error.HTTPError as error:
            assert error.code == 404
        else:
            raise RuntimeError("The test transfer is still available after deletion.")
    print(
        "PASS: replacement, transfer check, image and proxy recovery, and transfer retention.",
        flush=True,
    )
except Exception:  # noqa: BLE001 - Report the diagnostic path and then clean up.
    log.flush()
    print(
        "Rehearsal failed. Private Docker output: " + str(base / "docker.log"),
        flush=True,
    )
    raise SystemExit(1) from None
finally:
    cleaned = subprocess.run(
        prefix + ["down", "--volumes"], check=False, env=env, stdout=log, stderr=log
    )
    log.close()
    for service in ["web", "api"]:
        for sha in [old, new]:
            subprocess.run(
                ["docker", "image", "rm", project + "-" + service + ":" + sha],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
    if not os.environ.get("PASSING_KEEP_REHEARSAL"):
        shutil.rmtree(base)
    if cleaned.returncode:
        raise SystemExit("The rehearsal containers could not be removed.")
