#!/usr/bin/env python3
import pathlib
import shutil
import subprocess
import tempfile
import unittest


HELPER = (
    pathlib.Path(__file__).resolve().parents[2]
    / "home/.agents/skills/executing-plans/scripts/task-done"
)


class TaskDoneTest(unittest.TestCase):
    def setUp(self):
        self.repo = pathlib.Path(tempfile.mkdtemp())
        self.plan = self.repo / "plan.md"
        self.plan.write_text("# Test plan\n")
        self.git("init", "-b", "master")
        self.git("config", "user.name", "Task completion test")
        self.git("config", "user.email", "task-completion@example.invalid")
        self.git("add", "plan.md")
        self.git("-c", "core.hooksPath=/dev/null", "commit", "-m", "test plan")
        self.base = self.git("rev-parse", "HEAD")
        self.workspace = self.repo / ".git/sdd/plan"
        self.ledger = self.workspace / "progress.md"

    def tearDown(self):
        shutil.rmtree(self.repo)

    def git(self, *arguments):
        result = subprocess.run(
            ["git", "-C", str(self.repo), *arguments],
            text=True,
            capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout.strip()

    def run_task(self, command, number=1):
        return subprocess.run(
            ["/bin/bash", str(HELPER), str(self.plan), str(number), self.base,
             "--", "/bin/sh", "-c", command],
            cwd=self.repo,
            text=True,
            capture_output=True,
        )

    def test_silent_success_records_explicit_success(self):
        result = self.run_task("exit 0")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Task 1: complete", self.ledger.read_text())
        self.assertIn("passed (no output)", self.ledger.read_text())
        self.assertEqual((self.workspace / "task-1-tests.log").read_bytes(), b"")

    def test_whitespace_only_success_records_explicit_success(self):
        result = self.run_task("printf ' \\n\\t\\r\\n'")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("passed (no output)", self.ledger.read_text())

    def test_nonempty_success_records_last_nonblank_output(self):
        result = self.run_task("printf 'first\\nlast\\n\\n'")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("→ last)", self.ledger.read_text())

    def test_failure_does_not_create_completion_ledger(self):
        result = self.run_task("exit 23")
        self.assertEqual(result.returncode, 23)
        self.assertFalse(self.ledger.exists())
        self.assertIn("NOT recorded", result.stderr)

    def test_failure_preserves_existing_completion_ledger(self):
        first = self.run_task("printf 'passed\\n'")
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        before = self.ledger.read_bytes()
        result = self.run_task("printf 'failed\\n'; exit 17", number=2)
        self.assertEqual(result.returncode, 17)
        self.assertEqual(self.ledger.read_bytes(), before)
        self.assertEqual((self.workspace / "task-2-tests.log").read_text(), "failed\n")


if __name__ == "__main__":
    unittest.main()