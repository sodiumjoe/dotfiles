#!/usr/bin/env python3
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest


class ReconcileTest(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp())
        self.owner = self.root / "owner"
        self.repo = self.owner / ".dotfiles"
        self.home_tree = self.repo / "home"
        self.owner.mkdir()
        self.repo.mkdir()
        source = pathlib.Path(__file__).parent / "home" / "bin" / "dotfiles-reconcile"
        self.assertTrue(source.exists(), "home/bin/dotfiles-reconcile is missing")
        self.runner = self.root / "dotfiles-reconcile"
        shutil.copy2(source, self.runner)

    def tearDown(self):
        shutil.rmtree(self.root)

    def run_reconcile(self, home=None, check=True, arguments=(), environment="work"):
        home = home or self.owner
        result = subprocess.run(
            [str(self.runner), *arguments],
            env={
                **os.environ,
                "HOME": str(home),
                "DOTFILES_DIR": str(home / ".dotfiles"),
                "DOTFILES_ENV": environment,
            },
            text=True,
            capture_output=True,
        )
        if check and result.returncode != 0:
            self.fail(result.stderr)
        return result

    def write(self, relative, content="content", executable=False):
        path = self.home_tree / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        if executable:
            path.chmod(0o755)
        return path

    def test_runtime_files_are_not_deployed_but_configuration_is(self):
        runtime = [
            ".codex/state_9.sqlite", ".codex/state_9.sqlite-wal", ".codex/state_9.sqlite-shm",
            ".codex/goals_1.sqlite", ".codex/installation_id",
            ".codex/plugins/cache/marketplace/plugin/code.py",
            ".codex/skills/.system/example/SKILL.md", ".codex/.tmp/nested/payload",
            ".codex/tmp/nested/payload",
        ]
        managed = [
            ".codex/AGENTS.md", ".codex/config.toml", ".codex/plugins/manifest.json",
            ".codex/skills/custom/SKILL.md", ".agents/skills/custom/SKILL.md",
            ".config/tool/state.sqlite", ".config/tool/tmp/config", ".zshenv",
        ]
        for name in runtime + managed:
            self.write(name)
        self.run_reconcile(arguments=["--preflight"])
        self.assertFalse((self.owner / ".zshenv").exists())
        self.run_reconcile()
        for name in runtime:
            with self.subTest(name=name):
                self.assertFalse(os.path.lexists(self.owner / name))
                self.assertEqual((self.home_tree / name).read_text(), "content")
        for name in managed:
            with self.subTest(name=name):
                self.assertEqual((self.owner / name).resolve(), (self.home_tree / name).resolve())
        self.assertIn("changed=0", self.run_reconcile().stdout)


    def test_regular_file_conflict_prevents_all_mutation(self):
        conflict = self.owner / ".zshenv"
        conflict.write_text("keep")
        self.write(".zshenv", "managed")
        self.write(".gitconfig", "managed")
        result = self.run_reconcile(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(conflict.read_text(), "keep")
        self.assertFalse((self.owner / ".gitconfig").exists())


if __name__ == "__main__":
    unittest.main()