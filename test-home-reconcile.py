#!/usr/bin/env python3
import os
import pathlib
import shutil
import subprocess
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
        source = pathlib.Path(__file__).parent / "bin" / "dotfiles-reconcile"
        self.assertTrue(source.exists(), "bin/dotfiles-reconcile is missing")
        self.runner = self.root / "dotfiles-reconcile"
        shutil.copy2(source, self.runner)

    def tearDown(self):
        shutil.rmtree(self.root)

    def run_reconcile(self, home=None, check=True):
        home = home or self.owner
        result = subprocess.run(
            [str(self.runner)],
            env={
                **os.environ,
                "HOME": str(home),
                "DOTFILES_DIR": str(home / ".dotfiles"),
                "DOTFILES_ENV": "work",
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

    def test_missing_home_tree_fails(self):
        result = self.run_reconcile(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("home tree is missing", result.stderr)

    def test_relative_links_survive_home_relocation_and_converge(self):
        self.write(".zshenv")
        self.write("bin/tool", "#!/bin/sh\n", executable=True)
        first = self.run_reconcile()
        self.assertIn("changed=2", first.stdout)
        self.assertEqual(os.readlink(self.owner / ".zshenv"), ".dotfiles/home/.zshenv")
        self.assertFalse(os.path.isabs(os.readlink(self.owner / "bin/tool")))

        moon = self.root / "moon"
        self.owner.rename(moon)
        self.assertEqual((moon / ".zshenv").read_text(), "content")
        second = self.run_reconcile(moon)
        self.assertIn("changed=0", second.stdout)
        for relative in [".zshenv", "bin/tool"]:
            link = moon / relative
            before = link.lstat()
            third = self.run_reconcile(moon)
            after = link.lstat()
            self.assertIn("changed=0", third.stdout)
            self.assertEqual(before.st_ino, after.st_ino)
            self.assertEqual(before.st_ctime_ns, after.st_ctime_ns)

    def test_source_alias_links_directly_to_canonical_source(self):
        skill = self.write(".agents/skills/example/SKILL.md")
        alias = self.home_tree / ".claude/skills/example"
        alias.parent.mkdir(parents=True)
        alias.symlink_to("../../.agents/skills/example")
        self.run_reconcile()
        destination = self.owner / ".claude/skills/example"
        self.assertTrue(destination.is_symlink())
        self.assertEqual(destination.resolve(), skill.parent.resolve())
        self.assertFalse(os.path.isabs(os.readlink(destination)))

    def test_wrong_directory_symlink_is_replaced(self):
        self.write(".config/tool/config")
        (self.owner / ".config").mkdir()
        wrong = self.owner / ".config/tool"
        wrong.symlink_to("../missing")
        self.run_reconcile()
        self.assertTrue(wrong.is_dir())
        self.assertFalse(wrong.is_symlink())
        self.assertEqual((wrong / "config").read_text(), "content")

    def test_regular_file_conflict_prevents_all_mutation(self):
        conflict = self.owner / ".zshenv"
        conflict.write_text("keep")
        self.write(".zshenv", "managed")
        self.write(".gitconfig", "managed")
        result = self.run_reconcile(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(conflict.read_text(), "keep")
        self.assertFalse((self.owner / ".gitconfig").exists())

    def test_unresolved_source_alias_fails_before_mutation(self):
        self.write(".zshenv")
        alias = self.home_tree / "bin/missing"
        alias.parent.mkdir(parents=True)
        alias.symlink_to("../does-not-exist")
        result = self.run_reconcile(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.owner / ".zshenv").exists())

    def test_legacy_repository_directory_link_becomes_real_directory(self):
        old = self.repo / "zsh"
        old.mkdir()
        (old / ".zshrc").write_text("legacy")
        (self.owner / ".config").mkdir()
        (self.owner / ".config/zsh").symlink_to(old)
        self.write(".config/zsh/.zshrc")
        self.run_reconcile()
        self.assertTrue((self.owner / ".config/zsh").is_dir())
        self.assertFalse((self.owner / ".config/zsh").is_symlink())
        self.assertEqual((self.owner / ".config/zsh/.zshrc").read_text(), "content")

    def test_home_environment_prunes_only_repository_owned_optional_links(self):
        self.write(".codex/AGENTS.md")
        self.write(".codex/config.toml")
        self.write("bin/work", executable=True)
        self.run_reconcile()
        unrelated = self.owner / ".codex/session.json"
        unrelated.write_text("runtime")
        (self.home_tree / ".codex/AGENTS.md").unlink()
        (self.home_tree / ".codex/config.toml").unlink()

        result = subprocess.run(
            [str(self.runner)],
            env={
                **os.environ,
                "HOME": str(self.owner),
                "DOTFILES_DIR": str(self.repo),
                "DOTFILES_ENV": "home",
            },
            text=True,
            capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        for path in [
            self.owner / ".codex/AGENTS.md",
            self.owner / ".codex/config.toml",
            self.owner / "bin/work",
        ]:
            self.assertFalse(path.exists() or path.is_symlink(), path)
        self.assertEqual(unrelated.read_text(), "runtime")

    def test_optional_pruning_preserves_links_outside_repository(self):
        self.home_tree.mkdir(parents=True)
        external = self.root / "external"
        external.write_text("external")
        (self.owner / ".codex").mkdir()
        destination = self.owner / ".codex/AGENTS.md"
        destination.symlink_to(external)
        result = subprocess.run(
            [str(self.runner)],
            env={
                **os.environ,
                "HOME": str(self.owner),
                "DOTFILES_DIR": str(self.repo),
                "DOTFILES_ENV": "home",
            },
            text=True,
            capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(destination.resolve(), external.resolve())

    def test_invalid_environment_fails_without_mutation(self):
        self.write(".zshenv")
        result = subprocess.run(
            [str(self.runner)],
            env={
                **os.environ,
                "HOME": str(self.owner),
                "DOTFILES_DIR": str(self.repo),
                "DOTFILES_ENV": "typo",
            },
            text=True,
            capture_output=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("invalid DOTFILES_ENV", result.stderr)
        self.assertFalse((self.owner / ".zshenv").exists())


if __name__ == "__main__":
    unittest.main()
