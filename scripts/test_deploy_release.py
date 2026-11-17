import hashlib
import importlib.util
import io
import json
import tarfile
import tempfile
import threading
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "deploy_release", Path(__file__).with_name("deploy-release.py")
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
OLD = "1" * 40
NEW = "2" * 40


def archive(extra=None):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w") as output:
        for name in [
            "Dockerfile",
            "package.json",
            "package-lock.json",
            "compose.caddy.yaml",
        ]:
            member = tarfile.TarInfo(name)
            member.size = 2
            output.addfile(member, io.BytesIO(b"{}"))
        if extra:
            output.addfile(extra, io.BytesIO(b""))
    return stream.getvalue()


class FakeDeployer(MODULE.Deployer):
    def __init__(self, config):
        super().__init__(config)
        self.operations = []
        self.fail_build = False
        self.fail_health = False
        self.wrong_storage = False
        self.missing_image = False
        self.fail_proxy = False
        self.live = {
            name: "sha256:" + hashlib.sha256((name + OLD).encode()).hexdigest()
            for name in MODULE.SERVICES
        }

    def launch(self, job):
        self.operations.append("launch")

    def command(self, args, **kwargs):
        if args[:2] == ["docker", "run"]:
            self.operations.append("proxy-test")
            MODULE.require(not self.fail_proxy, "The proxy configuration is not valid.")
            return ""
        if args[:3] == ["docker", "image", "inspect"]:
            MODULE.require(not self.missing_image, "The saved image is absent.")
            reference = args[3]
            image = (
                reference
                if reference.startswith("sha256:")
                else "sha256:" + hashlib.sha256(reference.encode()).hexdigest()
            )
            return json.dumps([{"Id": image}])
        if args[0] == "systemctl":
            return "inactive\n"
        raise AssertionError(args)

    def container(self, service):
        return {
            "Image": self.live[service],
            "State": {"Running": True, "Health": {"Status": "healthy"}},
            "Mounts": [
                {
                    "Destination": "/app/data",
                    "Type": "bind",
                    "Source": self.config["data_mount"]["source"],
                }
            ],
        }

    def compose(self, source, metadata, sha, *args, **kwargs):
        self.operations.append(args[0])
        if args[0] == "config":
            return json.dumps(
                {
                    "services": {
                        "web": {"image": "web:" + sha},
                        "api": {
                            "image": "api:" + sha,
                            "environment": {
                                "PASSING_PUBLIC_ORIGIN": self.config["origin"]
                            },
                            "volumes": [
                                {
                                    "target": "/app/data",
                                    "type": "bind",
                                    "source": "/wrong"
                                    if self.wrong_storage
                                    else self.config["data_mount"]["source"],
                                }
                            ],
                        },
                        "proxy": {"image": "proxy:pinned"},
                    }
                }
            )
        if args[0] == "build" and self.fail_build:
            raise MODULE.DeploymentError("The build failed.")
        if args[0] == "up":
            self.live = {
                name: image["id"]
                for name, image in MODULE.read_json(metadata / "release.json")[
                    "images"
                ].items()
            }
            if self.fail_health:
                raise MODULE.DeploymentError("A container health check failed.")
        return ""


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="passing-deploy-test-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / "app"
        self.source = self.root / "releases" / OLD
        self.source.mkdir(parents=True)
        (self.source / "compose.caddy.yaml").write_text("{}")
        self.data = self.base / "transfer-data"
        self.data.mkdir()
        (self.data / "complete-file").write_bytes(b"encrypted test bytes")
        environment = self.base / "environment"
        environment.write_text("PASSING_ADMIN_KEY=test-only\n")
        config = self.base / "deploy.json"
        MODULE.write_json(
            config,
            {
                "root": str(self.root),
                "project": "test-project",
                "compose_file": "compose.caddy.yaml",
                "overrides": [],
                "env_file": str(environment),
                "origin": "https://app.example",
                "build_free_bytes": 0,
                "data_mount": {"type": "bind", "source": str(self.data)},
            },
        )
        MODULE.point(self.root / "current", self.source)
        self.deployer = FakeDeployer(config)
        self.deployer.adopt()

    def begin(self, payload=None):
        payload = archive() if payload is None else payload
        return self.deployer.begin(
            NEW, hashlib.sha256(payload).hexdigest(), io.BytesIO(payload)
        )["id"]

    def test_failed_build_keeps_the_current_release_and_allows_retry(self):
        self.deployer.fail_build = True
        job = self.begin()
        self.deployer.worker(job)
        self.assertEqual((self.root / "current").resolve(), self.source)
        self.assertEqual(self.deployer.status(job)["phase"], "failed")
        self.assertFalse(self.deployer.pending.exists())
        self.assertNotIn("up", self.deployer.operations)
        self.assertFalse((self.root / "releases" / NEW).exists())
        self.deployer.fail_build = False
        self.deployer.worker(self.begin())
        self.assertEqual((self.root / "current").resolve().name, NEW)

    def test_success_requires_external_confirmation_and_preserves_transfer_data(self):
        self.assertEqual(self.deployer.info()["origin"], "https://app.example")
        job = self.begin()
        self.deployer.worker(job)
        status = self.deployer.status(job)
        self.assertEqual(status["phase"], "awaiting-verification")
        self.assertEqual(status["origin"], "https://app.example")
        self.assertEqual((self.root / "last-successful").resolve().name, OLD)
        self.deployer.finish(job, "success")
        self.assertEqual((self.root / "last-successful").resolve().name, NEW)
        self.assertEqual((self.root / "previous").resolve().name, OLD)
        self.assertEqual(
            (self.data / "complete-file").read_bytes(), b"encrypted test bytes"
        )

    def test_origin_change_after_queueing_stops_before_build(self):
        job = self.begin()
        MODULE.write_json(
            self.deployer.config_path,
            {**self.deployer.config, "origin": "https://other.example"},
        )
        self.deployer.worker(job)
        status = self.deployer.status(job)
        self.assertEqual(status["phase"], "failed")
        self.assertEqual(status["origin"], "https://app.example")
        self.assertNotIn("build", self.deployer.operations)

    def test_origin_change_before_lock_is_checked_before_accepting_the_archive(self):
        payload = archive()
        previous_origin = self.deployer.config["origin"]
        current_origin = "https://other.example"
        MODULE.write_json(
            self.deployer.config_path,
            {**self.deployer.config, "origin": current_origin},
        )
        checksum = hashlib.sha256(payload).hexdigest()
        with self.assertRaisesRegex(MODULE.DeploymentError, "requested origin"):
            self.deployer.begin(
                NEW,
                checksum,
                io.BytesIO(payload),
                expected_origin=previous_origin.encode().hex(),
            )
        self.assertFalse(self.deployer.pending.exists())
        self.assertFalse((self.deployer.state / "incoming").exists())
        self.assertNotIn("launch", self.deployer.operations)
        started = self.deployer.begin(
            NEW, checksum, io.BytesIO(payload), expected_origin=current_origin.encode().hex()
        )
        self.assertEqual(started["origin"], current_origin)
        self.assertEqual(self.deployer.status(started["id"])["origin"], current_origin)

    def test_failed_activation_keeps_recovery_images_and_blocks_another_deployment(
        self,
    ):
        self.deployer.fail_health = True
        job = self.begin()
        self.deployer.worker(job)
        self.assertEqual(self.deployer.status(job)["phase"], "failed-after-switch")
        self.assertEqual((self.root / "last-successful").resolve().name, OLD)
        with self.assertRaises(MODULE.DeploymentError):
            self.begin()
        self.deployer.finish(job, "failure")
        with self.assertRaisesRegex(MODULE.DeploymentError, "Recover"):
            self.begin()

    def test_recovery_requires_compatibility_confirmation_and_uses_saved_images(self):
        with self.assertRaisesRegex(MODULE.DeploymentError, "compatibility"):
            self.deployer.begin(OLD, recover=True)
        job = self.begin()
        self.deployer.worker(job)
        self.deployer.finish(job, "failure")
        self.deployer.operations.clear()
        recovery = self.deployer.begin(OLD, recover=True, compatible=True)["id"]
        self.deployer.worker(recovery)
        self.deployer.finish(recovery, "success")
        self.assertEqual((self.root / "current").resolve().name, OLD)
        self.assertNotIn("build", self.deployer.operations)
        self.assertNotIn("pull", self.deployer.operations)

    def test_missing_saved_image_stops_recovery_before_the_switch(self):
        self.deployer.missing_image = True
        job = self.deployer.begin(OLD, recover=True, compatible=True)["id"]
        self.deployer.worker(job)
        self.assertEqual(self.deployer.status(job)["phase"], "failed")
        self.assertNotIn("up", self.deployer.operations)

    def test_storage_change_stops_before_build(self):
        self.deployer.wrong_storage = True
        job = self.begin()
        self.deployer.worker(job)
        self.assertEqual(self.deployer.status(job)["phase"], "failed")
        self.assertNotIn("build", self.deployer.operations)
        self.assertEqual((self.root / "current").resolve(), self.source)

    def test_bad_proxy_configuration_stops_before_the_switch(self):
        self.deployer.fail_proxy = True
        job = self.begin()
        self.deployer.worker(job)
        self.assertEqual(self.deployer.status(job)["phase"], "failed")
        self.assertEqual(self.deployer.status(job)["stage"], "proxy configuration")
        self.assertNotIn("up", self.deployer.operations)
        self.assertEqual((self.root / "current").resolve(), self.source)
        self.assertFalse(self.deployer.metadata(NEW).exists())
        self.assertFalse((self.root / "releases" / NEW).exists())
        self.deployer.fail_proxy = False
        retry = self.begin()
        self.deployer.worker(retry)
        self.assertEqual(self.deployer.status(retry)["phase"], "awaiting-verification")

    def test_pending_and_locked_operations_cannot_overlap(self):
        job = self.begin()
        with self.assertRaisesRegex(MODULE.DeploymentError, "pending"):
            FakeDeployer(self.deployer.config_path).begin(
                NEW, hashlib.sha256(archive()).hexdigest(), io.BytesIO(archive())
            )
        with (
            self.deployer.lock(),
            self.assertRaisesRegex(MODULE.DeploymentError, "progress"),
        ):
            self.deployer.finish(job, "failure")

    def test_detached_worker_waits_for_the_launching_command_to_release_its_lock(self):
        job = self.begin()
        errors = []
        started = threading.Event()

        def work():
            started.set()
            try:
                self.deployer.worker(job)
            except Exception as error:  # noqa: BLE001 - Report thread failures to the parent test.
                errors.append(error)

        worker = threading.Thread(target=work)
        with self.deployer.lock():
            worker.start()
            self.assertTrue(started.wait(1))
            worker.join(0.05)
            self.assertTrue(worker.is_alive())
        worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(self.deployer.status(job)["phase"], "awaiting-verification")

    def test_archive_checksum_is_checked_before_launch(self):
        with self.assertRaisesRegex(MODULE.DeploymentError, "checksum"):
            self.deployer.begin(NEW, "0" * 64, io.BytesIO(archive()))
        self.assertFalse(self.deployer.pending.exists())

    def test_archive_rejects_private_files_links_and_parent_paths(self):
        for name in [
            "../../outside",
            "/absolute",
            ".env",
            "ops/private/record",
            "deploy/certs/key",
        ]:
            with self.subTest(name=name):
                member = tarfile.TarInfo(name)
                payload = archive(member)
                job = self.begin(payload)
                self.deployer.worker(job)
                self.assertEqual(self.deployer.status(job)["phase"], "failed")
        member = tarfile.TarInfo("link")
        member.type = tarfile.SYMTYPE
        member.linkname = "/etc"
        job = self.begin(archive(member))
        self.deployer.worker(job)
        self.assertEqual(self.deployer.status(job)["phase"], "failed")
        self.assertEqual((self.root / "current").resolve(), self.source)

    def test_external_confirmation_rechecks_the_running_images(self):
        job = self.begin()
        self.deployer.worker(job)
        self.deployer.live["api"] = "sha256:" + "f" * 64
        with self.assertRaisesRegex(MODULE.DeploymentError, "running images"):
            self.deployer.finish(job, "success")
        self.assertEqual((self.root / "last-successful").resolve().name, OLD)
        self.assertTrue(self.deployer.pending.exists())


if __name__ == "__main__":
    unittest.main()
