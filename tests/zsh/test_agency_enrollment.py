import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[2]
HOST_ID = "a" * 64


class AgencyEnrollmentTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="agency-enrollment-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.env = dict(os.environ, HOME=str(self.root), PATH=f"{self.bin}:/usr/bin:/bin",
                        ENROLL_TEST_ROOT=str(self.root), ENROLL_STATUS=json.dumps({
                            "protocol": "agency-control/2", "ok": True,
                            "result": {"phase": "ready", "hostId": HOST_ID}}))
        self.executable("ssh", r"""
import json, os, pathlib, sys, time
root = pathlib.Path(os.environ['ENROLL_TEST_ROOT'])
(root / 'ssh.json').write_text(json.dumps(sys.argv[1:]))
time.sleep(float(os.environ.get('ENROLL_SSH_DELAY', '0')))
print(os.environ.get('ENROLL_STATUS', ''))
if os.environ.get('ENROLL_SSH_ERROR'): print(os.environ['ENROLL_SSH_ERROR'], file=sys.stderr)
sys.exit(int(os.environ.get('ENROLL_SSH_EXIT', '0')))
""")
        self.executable("agy", r"""
import json, os, pathlib, sys
root = pathlib.Path(os.environ['ENROLL_TEST_ROOT'])
(root / 'enroll.json').write_text(json.dumps(sys.argv[1:]))
print(os.environ.get('ENROLL_LOCAL_REPLY', '{"ok":true}'))
sys.exit(int(os.environ.get('ENROLL_LOCAL_EXIT', '0')))
""")

    def executable(self, name, source):
        path = self.bin / name
        path.write_text(f"#!{sys.executable}\n" + source)
        path.chmod(0o700)

    def enroll(self, action="_devbox_agency_enroll"):
        return subprocess.run(["/bin/zsh", "-f", "-c", 'source "$1"; ' + action + ' "$2"',
                               "test", str(ROOT / "home/.config/zsh/work_sync.zsh"), "worker"],
                              env=self.env, capture_output=True, text=True, timeout=10)

    def test_enrollment_uses_only_hostname_and_host_id(self):
        result = self.enroll()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout + result.stderr, "")
        args = json.loads((self.root / "enroll.json").read_text())
        self.assertEqual(args[:3], ["host", "enroll", "--input-json"])
        self.assertEqual(json.loads(args[3]), {"hostname": "worker", "hostId": HOST_ID})
        self.assertEqual(args[4:], ["--json"])
        ssh = json.loads((self.root / "ssh.json").read_text())
        self.assertEqual(ssh[-3:], ["--", "worker", "exec agy status --json"])
        for option in ["-T", "BatchMode=yes", "StrictHostKeyChecking=yes", "ConnectTimeout=10", "ControlMaster=auto"]:
            self.assertIn(option, ssh)


    def test_background_enrollment_does_not_delay_attachment(self):
        self.env["ENROLL_SSH_DELAY"] = "1.5"
        errors = self.root / "errors"
        with errors.open("w") as stderr:
            started = time.monotonic()
            result = subprocess.run(["/bin/zsh", "-f", "-c",
                                     'source "$1"; _devbox_agency_enroll_background worker; printf attached',
                                     "test", str(ROOT / "home/.config/zsh/work_sync.zsh")],
                                    env=self.env, capture_output=False, stdout=subprocess.PIPE,
                                    stderr=stderr, text=True, timeout=3)
        self.assertLess(time.monotonic() - started, 1)
        self.assertEqual(result.stdout, "attached")
        deadline = time.monotonic() + 5
        while not (self.root / "enroll.json").exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertTrue((self.root / "enroll.json").exists(), errors.read_text())
        self.assertEqual(errors.read_text(), "")


if __name__ == "__main__":
    unittest.main()