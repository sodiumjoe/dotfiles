import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
CLIMATE, STRIPELET, OLD, GONE = (f"qa-mydev--{name}.northwest.stripe.io" for name in ("aaa", "bbb", "ccc", "ddd"))


def restart_reply(ok, agents=0, code=None, message=""):
    if ok:
        return json.dumps({"ok": True, "result": {"state": "restarted", "agents": [{"agentId": str(index), "outcome": "restored"} for index in range(agents)]}})
    return json.dumps({"ok": False, "error": {"code": code, "message": message}})


class DevboxesUpdateTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="devboxes-update-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.replies = {
            CLIMATE: {"stdout": "pulling\n@@ restart " + restart_reply(True, 2) + "\n@@ result ok 5d9761f 0cb5394\n", "exit": 0},
            STRIPELET: {"stdout": "@@ restart " + restart_reply(False, code="BUSY", message="agent is working") + "\n@@ result ok 0cb5394 0cb5394\n", "exit": 0},
            OLD: {"stdout": "error: cannot pull\n@@ result failed pull refused (local changes or diverged)\n", "exit": 0},
            GONE: {"stdout": "ssh: connect to host: timed out\n", "exit": 255},
        }
        self.env = dict(os.environ, HOME=str(self.root), TMPDIR=str(self.root), PATH=f"{self.bin}:/usr/bin:/bin",
                        DEVBOXES_TEST_ROOT=str(self.root), DEVBOXES_AHEAD="0",
                        DEVBOXES_HOSTS=json.dumps([CLIMATE, STRIPELET, OLD, GONE]),
                        DEVBOXES_PAY=json.dumps([{"name": "stripelet", "host": STRIPELET}, {"name": "climate", "host": CLIMATE}, {"name": "gone-box", "host": None, "status": "scheduledfordeletion"}]))
        self.executable("agy", r"""
import json, os, sys
assert sys.argv[1:] == ["host", "list", "--json"], sys.argv
print(json.dumps({"ok": True, "result": {"state": "hosts", "hosts": [{"hostId": "a" * 64, "hostname": h} for h in json.loads(os.environ["DEVBOXES_HOSTS"])]}}))
""")
        self.executable("git", r"""
import os, sys
args = sys.argv[1:]
if args[:1] == ["-C"]: args = args[2:]
if args[:1] == ["fetch"]: sys.exit(0)
if args[:2] == ["rev-list", "--count"]: print(os.environ["DEVBOXES_AHEAD"]); sys.exit(0)
if args[:2] == ["rev-parse", "--short"]: print("0cb5394"); sys.exit(0)
sys.exit(2)
""")
        self.executable("pay", r"""
import os, sys
print(os.environ["DEVBOXES_PAY"])
""")
        self.executable("ssh", r"""
import json, os, pathlib, sys
root = pathlib.Path(os.environ["DEVBOXES_TEST_ROOT"])
host = sys.argv[-2]
(root / ("ssh-" + host.split(".")[0] + ".json")).write_text(json.dumps(sys.argv[1:]))
reply = json.loads((root / "replies.json").read_text())[host]
sys.stdout.write(reply["stdout"])
sys.exit(reply["exit"])
""")

    def executable(self, name, source):
        path = self.bin / name
        path.write_text(f"#!{sys.executable}\n" + source)
        path.chmod(0o700)

    def update(self):
        (self.root / "replies.json").write_text(json.dumps(self.replies))
        return subprocess.run(["/bin/zsh", "-f", "-c", 'unalias git 2>/dev/null; source "$1"; devboxes-update', "test", str(ROOT / "home/.config/zsh/work_sync.zsh")],
                              env=self.env, capture_output=True, text=True, timeout=30)

    def test_refuses_when_local_master_is_ahead_of_origin(self):
        self.env["DEVBOXES_AHEAD"] = "2"
        result = self.update()
        self.assertEqual(result.returncode, 1)
        self.assertIn("push first", result.stderr)
        self.assertEqual(list(self.root.glob("ssh-*.json")), [])

    def test_updates_every_box_and_summarizes_each_outcome(self):
        result = self.update()
        self.assertEqual(result.returncode, 1, result.stderr)
        lines = [line.split(None, 1) for line in result.stdout.splitlines()]
        self.assertEqual(lines[0], ["devboxes", "will pull origin/master at 0cb5394"])
        summary = {name: text for name, text in lines[1:]}
        self.assertEqual(summary["climate"], "updated 5d9761f → 0cb5394, restarted (2 agents handed over)")
        self.assertEqual(summary["stripelet"], "already at 0cb5394, restart pending: busy (rerun later)")
        self.assertEqual(sorted(summary), ["climate", "qa-mydev--ccc", "qa-mydev--ddd", "stripelet"])
        self.assertRegex(summary["qa-mydev--ccc"], r"^failed: pull refused \(local changes or diverged\); see .*devboxes-update-qa-mydev--ccc\.log$")
        self.assertRegex(summary["qa-mydev--ddd"], r"^failed: unreachable or timed out \(exit 255\); see .*devboxes-update-qa-mydev--ddd\.log$")
        self.assertIn("ssh: connect to host: timed out", (self.root / "devboxes-update-qa-mydev--ddd.log").read_text())

    def test_each_box_gets_one_noninteractive_command_with_a_remote_time_limit(self):
        self.update()
        args = json.loads((self.root / "ssh-qa-mydev--aaa.json").read_text())
        self.assertIn("BatchMode=yes", args)
        self.assertIn("-n", args)
        self.assertEqual(args[-2], CLIMATE)
        command = args[-1]
        self.assertTrue(command.startswith("timeout 900 bash -c "), command)
        for step in ("git pull --ff-only", "./bootstrap.sh", "agy restart --timeout 30 --json"):
            self.assertIn(step, command)

    def test_all_boxes_current_and_idle_succeeds(self):
        for host in self.replies:
            self.replies[host] = {"stdout": "@@ restart " + restart_reply(True) + "\n@@ result ok 0cb5394 0cb5394\n", "exit": 0}
        result = self.update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("already at 0cb5394, restarted", result.stdout)


if __name__ == "__main__":
    unittest.main()