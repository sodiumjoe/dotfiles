import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]

FAKE_SSH = r'''#!/bin/sh
printf '%s\n' "$*" >> "$SSH_LOG"
case "$*" in
  -G*) echo "controlpath $SSH_CONTROL"; exit 0 ;;
  *"-O exit"*) exit 0 ;;
esac
count=$(cat "$SSH_COUNT" 2>/dev/null || echo 0)
count=$((count + 1))
echo "$count" > "$SSH_COUNT"
code=$(sed -n "${count}p" "$SSH_CODES")
exit "${code:-0}"
'''


class DevboxAttachTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="devbox-attach-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        ssh = bin_dir / "ssh"
        ssh.write_text(FAKE_SSH)
        ssh.chmod(0o755)
        self.log, self.codes = self.root / "ssh.log", self.root / "codes"
        self.env = dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}", HOME=str(self.root),
                        SSH_LOG=str(self.log), SSH_COUNT=str(self.root / "count"), SSH_CODES=str(self.codes),
                        SSH_CONTROL=str(self.root / "control"), DEVBOX_RECONNECT_DELAY="0")
        self.env.pop("TMUX_PANE", None)

    def attach(self, *codes):
        self.codes.write_text("".join(f"{code}\n" for code in codes))
        script = 'source "$1"; _devbox_control_path() { print -r -- "$HOME/control"; }; _devbox_attach_tmux devbox.example'
        result = subprocess.run(["zsh", "-f", "-c", script, "test", str(ROOT / "home/.config/zsh/work_sync.zsh")],
                                env=self.env, capture_output=True, text=True, timeout=20)
        calls = self.log.read_text().splitlines() if self.log.exists() else []
        attaches = [call for call in calls if call.startswith("-o ControlMaster=auto")]
        exits = [call for call in calls if "-O exit" in call]
        return result, attaches, exits

    def test_reconnects_once_after_a_lost_connection(self):
        result, attaches, exits = self.attach(255, 0)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(attaches), 2)
        self.assertEqual(len(exits), 1)
        self.assertIn("reconnecting", result.stderr)

    def test_does_not_retry_a_clean_detach(self):
        result, attaches, exits = self.attach(0)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(attaches), 1)
        self.assertEqual(exits, [])

    def test_gives_up_after_one_reconnect(self):
        result, attaches, _ = self.attach(255, 255)
        self.assertEqual(result.returncode, 255)
        self.assertEqual(len(attaches), 2)

    def test_does_not_retry_other_failures(self):
        result, attaches, _ = self.attach(1)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(len(attaches), 1)


if __name__ == "__main__":
    unittest.main()