import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless(shutil.which("unison"), "Unison is required")
class WorkSyncTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="markdown-sync-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.local = self.root / "stripe/work"
        self.remote = self.root / "remote"
        self.archives = self.root / "archives"
        self.host = "markdown-test-" + self.root.name
        for directory in (self.local, self.remote, self.archives):
            directory.mkdir(parents=True)
        self.env = dict(os.environ, HOME=str(self.root), UNISON=str(self.archives),
                        SYNC_TEST_REMOTE=str(self.remote), SYNC_TEST_CONTROL=str(self.root))
        self.setup = r'''
source "$1"
_devbox_sync_preflight() { return 0; }
_devbox_remote_work_uri() { print -r -- "$SYNC_TEST_REMOTE"; }
_devbox_control_path() { print -r -- "$SYNC_TEST_CONTROL/control"; }
_devbox_ssh() { return 0; }
'''

    def write(self, root, relative, contents):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(contents)
        return path

    def sync(self):
        result = subprocess.run(["zsh", "-f", "-c", self.setup + '_devbox_sync "$2"',
                                 "test", str(ROOT / "home/.config/zsh/work_sync.zsh"), self.host],
                                env=self.env, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_foreground_sync_preserves_artifacts_and_syncs_note_changes(self):
        note = self.write(self.local, "nested/project notes.md", "original")
        self.write(self.local, "existing.json", "original artifact")
        self.write(self.local, "nested/report.json", "retained artifact")
        seeded = subprocess.run(["unison", str(self.local), str(self.remote), "-batch", "-silent",
                                 "-logfile", str(self.root / "seed.log")],
                                env=self.env, capture_output=True, text=True, timeout=20)
        self.assertEqual(seeded.returncode, 0, seeded.stdout + seeded.stderr)
        self.write(self.local, "existing.json", "changed local artifact")
        note.write_text("updated note with different length")
        self.write(self.local, "new.json", "local artifact")
        self.write(self.local, "README", "extensionless artifact")
        self.write(self.remote, "remote/note.md", "remote note")
        self.write(self.remote, "remote/result.html", "remote artifact")
        self.write(self.local, "node_modules/package/readme.md", "ignored note")
        self.write(self.local, ".obsidian/readme.md", "ignored note")
        self.sync()
        self.assertEqual((self.remote / "nested/project notes.md").read_text(), note.read_text())
        self.assertEqual((self.local / "remote/note.md").read_text(), "remote note")
        self.assertEqual((self.remote / "existing.json").read_text(), "original artifact")
        for relative in ("new.json", "README", "node_modules", ".obsidian"):
            self.assertFalse((self.remote / relative).exists(), relative)
        self.assertFalse((self.local / "remote/result.html").exists())
        note.unlink()
        (self.local / "nested/report.json").unlink()
        note.parent.rmdir()
        (self.remote / "existing.json").unlink()
        self.sync()
        self.assertFalse((self.remote / "nested/project notes.md").exists())
        self.assertEqual((self.remote / "nested/report.json").read_text(), "retained artifact")
        self.assertEqual((self.local / "existing.json").read_text(), "changed local artifact")

    def test_background_sync_discovers_new_notes_and_stops(self):
        self.write(self.local, "result.json", "artifact")
        script = self.setup + r'''
_devbox_sync_loop "$2"
sync_pid=$(cat "/tmp/unison-sync-${2}.pid")
print -r -- "$sync_pid" > "$SYNC_TEST_CONTROL/pid"
while [[ ! -f "$SYNC_TEST_CONTROL/stop" ]]; do sleep 0.1; done
_devbox_sync_loop_stop "$2"
wait "$sync_pid" 2>/dev/null
exit 0
'''
        with (self.root / "shell.log").open("w") as log:
            process = subprocess.Popen(["zsh", "-f", "-c", script, "test",
                                        str(ROOT / "home/.config/zsh/work_sync.zsh"), self.host],
                                       env=self.env, stdout=log, stderr=log)
            try:
                self.wait_for(lambda: (self.root / "pid").exists(), process)
                time.sleep(1)
                self.assertFalse((self.remote / "result.json").exists())
                self.write(self.local, "created later/deep/note.md", "local note")
                self.write(self.remote, "remote later/note.md", "remote note")
                self.write(self.remote, "remote later/data.json", "remote artifact")
                self.wait_for(lambda: (self.remote / "created later/deep/note.md").exists()
                              and (self.local / "remote later/note.md").exists(), process)
                self.assertEqual((self.remote / "created later/deep/note.md").read_text(), "local note")
                self.assertEqual((self.local / "remote later/note.md").read_text(), "remote note")
                self.assertFalse((self.local / "remote later/data.json").exists())
            finally:
                (self.root / "stop").touch()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            if (self.root / "pid").exists():
                pid = int((self.root / "pid").read_text())
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)
            self.assertEqual(process.returncode, 0, (self.root / "shell.log").read_text())

    def test_empty_note_replica_keeps_unison_deletion_protection(self):
        note = self.write(self.local, "note.md", "note")
        self.sync()
        note.unlink()
        result = subprocess.run(self.helper(), env=self.env, capture_output=True,
                                text=True, timeout=10)
        self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
        self.assertEqual((self.remote / "note.md").read_text(), "note")

    def helper(self, *extra):
        return [sys.executable, str(ROOT / "home/.config/zsh/work_sync_markdown.py"),
                *extra, str(self.local), str(self.remote), "-batch"]

    def executable(self, name, body):
        directory = self.root / "bin"
        directory.mkdir(exist_ok=True)
        path = directory / name
        path.write_text(f"#!{sys.executable}\n" + body)
        path.chmod(0o700)
        self.env["PATH"] = str(directory) + os.pathsep + os.environ["PATH"]

    def test_failed_remote_listing_does_not_start_unison(self):
        self.write(self.local, "note.md", "note")
        self.executable("ssh", "raise SystemExit(7)")
        self.executable("unison", f"from pathlib import Path; Path({str(self.root / 'started')!r}).touch()")
        command = self.helper()
        command[-2] = "ssh://worker//home/owner/stripe/work/"
        result = subprocess.run(command, env=self.env, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 3)
        self.assertIn("Could not list Markdown files", result.stderr)
        self.assertFalse((self.root / "started").exists())

    def test_stopping_during_transfer_terminates_unison(self):
        self.write(self.local, "note.md", "note")
        child_pid_file = self.root / "child.pid"
        self.executable("unison", f"import os, time\nfrom pathlib import Path\nPath({str(child_pid_file)!r}).write_text(str(os.getpid()))\ntime.sleep(60)")
        with (self.root / "shell.log").open("w") as log:
            process = subprocess.Popen(self.helper("--repeat", "5"), env=self.env,
                                       stdout=log, stderr=log)
            try:
                self.wait_for(child_pid_file.exists, process)
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                    raise
        self.assertEqual(process.returncode, 128 + 15)
        with self.assertRaises(ProcessLookupError):
            os.kill(int(child_pid_file.read_text()), 0)
        self.assertEqual(list(self.archives.glob("markdown-*.prf")), [])

    def wait_for(self, predicate, process):
        deadline = time.monotonic() + 15
        while not predicate():
            self.assertIsNone(process.poll(), (self.root / "shell.log").read_text())
            self.assertLess(time.monotonic(), deadline, "Timed out waiting for synchronization")
            time.sleep(0.1)


if __name__ == "__main__":
    unittest.main()