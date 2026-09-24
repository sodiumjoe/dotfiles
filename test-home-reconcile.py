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

    def test_missing_home_tree_fails(self):
        result = self.run_reconcile(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("home tree is missing", result.stderr)

    def test_moved_reconciler_finds_repository_without_override(self):
        self.write(".zshenv")
        executable = self.repo / "home/bin/dotfiles-reconcile"
        executable.parent.mkdir(parents=True)
        shutil.copy2(self.runner, executable)
        environment = {
            key: value for key, value in os.environ.items()
            if key != "DOTFILES_DIR"
        }
        environment.update({"HOME": str(self.owner), "DOTFILES_ENV": "work"})
        result = subprocess.run(
            [str(executable)],
            env=environment,
            text=True,
            capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.owner / ".zshenv").read_text(), "content")

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

    def test_preflight_checks_new_generated_destinations(self):
        self.write(".zshenv")
        generated = self.root / "generated"
        (generated / ".claude").mkdir(parents=True)
        (generated / ".claude/settings.json").write_text("{}")
        (self.owner / ".claude").mkdir()
        conflict = self.owner / ".claude/settings.json"
        conflict.write_text("unmanaged")
        result = self.run_reconcile(
            arguments=["--preflight", "--generated-root", str(generated)],
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("destination conflict", result.stderr)
        self.assertEqual(conflict.read_text(), "unmanaged")
        self.assertFalse((self.owner / ".zshenv").exists())
        self.assertFalse((self.home_tree / ".claude/settings.json").exists())

    def test_claude_settings_is_managed_in_work_and_home(self):
        source = self.write(".claude/settings.json", '{"managed": true}\n')
        for environment in ["work", "home"]:
            with self.subTest(environment=environment):
                self.run_reconcile(environment=environment)
                destination = self.owner / ".claude/settings.json"
                self.assertTrue(destination.is_symlink())
                self.assertEqual(destination.resolve(), source.resolve())

    def test_devbox_preserves_platform_claude_settings(self):
        self.write(".claude/settings.json", '{"managed": true}\n')
        hook = self.write(".claude/hooks/managed.sh", "managed\n")
        claude = self.owner / ".claude"
        claude.mkdir()
        settings = claude / "settings.json"
        settings.write_text('{"platform": true}\n')

        result = self.run_reconcile(environment="devbox")

        self.assertIn("changed=1", result.stdout)
        self.assertTrue(claude.is_dir())
        self.assertFalse(claude.is_symlink())
        self.assertEqual(settings.read_text(), '{"platform": true}\n')
        self.assertFalse(settings.is_symlink())
        self.assertEqual((claude / "hooks/managed.sh").resolve(), hook.resolve())

    def test_devbox_transition_prunes_repo_owned_claude_settings_link(self):
        self.write(".claude/settings.json", '{"managed": true}\n')
        hook = self.write(".claude/hooks/managed.sh", "managed\n")
        self.run_reconcile(environment="work")
        settings = self.owner / ".claude/settings.json"
        self.assertTrue(settings.is_symlink())

        result = self.run_reconcile(environment="devbox")

        self.assertIn("changed=1", result.stdout)
        self.assertFalse(settings.exists() or settings.is_symlink())
        self.assertEqual((self.owner / ".claude/hooks/managed.sh").resolve(), hook.resolve())

    def test_preflight_is_read_only_and_ignores_generated_brewfile(self):
        self.write(".zshenv")
        generated = self.root / "generated"
        (generated / ".claude").mkdir(parents=True)
        (generated / ".claude/settings.json").write_text("{}")
        (generated / "Brewfile").write_text("generated packages")
        (self.owner / "Brewfile").write_text("unmanaged packages")
        result = self.run_reconcile(
            arguments=["--preflight", "--generated-root", str(generated)],
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.owner / ".zshenv").exists())
        self.assertFalse((self.owner / ".claude").exists())
        self.assertFalse((self.owner / ".codex").exists())
        self.assertEqual((self.owner / "Brewfile").read_text(), "unmanaged packages")

    def test_generated_staging_requires_read_only_preflight(self):
        self.write(".zshenv")
        generated = self.root / "generated"
        generated.mkdir()
        result = self.run_reconcile(
            arguments=["--generated-root", str(generated)],
            check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("--preflight", result.stderr)
        self.assertFalse((self.owner / ".zshenv").exists())

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

    def test_deployed_scripts_use_home_bin_layout(self):
        repository = pathlib.Path(__file__).parent
        required = {
            "bootstrap.sh": [
                "home/bin/dotfiles-generate",
                "home/bin/dotfiles-reconcile",
            ],
            "hooks/post-merge": [
                "home/bin/dotfiles-generate",
                "home/bin/dotfiles-diff",
            ],
            "home/bin/brew-sync": [
                '$(dirname "$(readlink -f "$0")")/../..',
                "home/bin/dotfiles-generate",
            ],
            "home/bin/dotfiles-diff": [
                '$(dirname "$(readlink -f "$0")")/../..',
                "home/bin/dotfiles-generate",
                "home/.claude/settings.json",
                "home/.codex/config.toml",
            ],
            "home/bin/dotfiles-reconcile": [
                "script.parents[2]",
            ],
            "hooks/test/post-merge-node-bin.test.sh": [
                'mkdir -p "$tmpdir/repo/home/bin"',
                "home/bin/dotfiles-diff",
                "home/bin/dotfiles-generate",
            ],
        }
        for relative, needles in required.items():
            content = (repository / relative).read_text()
            for needle in needles:
                self.assertIn(needle, content, f"{relative}: {needle}")

        self_test = (repository / "test-home-reconcile.py").read_text()
        self.assertIn('parent / "home" / "bin" / "dotfiles-reconcile"', self_test)
        obsolete_source = 'parent / "bin" / "dotfiles-' + 'reconcile"'
        self.assertNotIn(obsolete_source, self_test)

    def test_repository_uses_canonical_home_layout(self):
        repository = pathlib.Path(__file__).parent
        tracked = set(
            subprocess.check_output(
                ["git", "ls-files"], cwd=repository, text=True
            ).splitlines()
        )
        expected = {
            "home/.curlrc",
            "home/.cvimrc",
            "home/.gitconfig",
            "home/.ignore",
            "home/.inputrc",
            "home/.zshenv",
            "home/.config/zsh/.zshrc",
            "home/.config/tmux/tmux.conf",
            "home/.tmux.conf",
            "home/.claude/agents/code-reviewer.md",
            "home/.claude/commands/create-project.md",
            "home/.claude/hooks/notify-on-stop.sh",
            "home/.agents/skills/using-superpowers/SKILL.md",
            "home/.claude/skills/using-superpowers",
            "home/bin/work",
            "tests/zsh/startup_test.sh",
            "tests/hammerspoon/zoom_window_layout_test.sh",
        }
        self.assertTrue(expected <= tracked, expected - tracked)
        obsolete_roots = {
            "curlrc", "cvimrc", "gitconfig", "ignore", "inputrc", "zshenv",
            "alacritty", "efm-langserver", "ghostty", "hammerspoon", "karabiner",
            "rg", "tmux", "vivid", "work", "zsh",
        }
        stale = {
            path for path in tracked
            if path.split("/", 1)[0] in obsolete_roots
        }
        self.assertEqual(stale, set())
        self.assertFalse((repository / "home/.codex/skills").exists())

        for skill in (repository / "home/.agents/skills").iterdir():
            alias = repository / "home/.claude/skills" / skill.name
            self.assertTrue(alias.is_symlink(), alias)
            self.assertEqual(os.readlink(alias), f"../../.agents/skills/{skill.name}")

        work_alias = repository / "home/bin/work"
        self.assertTrue(work_alias.is_symlink())
        self.assertEqual(os.readlink(work_alias), "../../work-cli/bin/work")

        discarded = [
            ".zcompdump",
            ".zcompdump-5.9",
            ".zcompdump-5.9.2",
            ".zcompdump-5.9.2.dat",
            ".zcompdump-5.9.2.zwc",
            ".zcompdump-5.9.dat",
            ".zcompdump-5.9.zwc",
            ".zim",
            ".zsh_history",
            ".zsh_sessions",
        ]
        for name in discarded:
            self.assertFalse((repository / "home/.config/zsh" / name).exists(), name)

        tmux_alias = repository / "home/.tmux.conf"
        self.assertTrue(tmux_alias.is_symlink())
        self.assertEqual(os.readlink(tmux_alias), ".config/tmux/tmux.conf")
        cvim = (repository / "home/.cvimrc").read_text()
        self.assertNotIn("/Users/moon", cvim)
        self.assertIn("let homedirectory = ''", cvim)

        bootstrap = (repository / "bootstrap.sh").read_text()
        self.assertIn("home/bin/dotfiles-reconcile", bootstrap)
        self.assertNotIn("xdg_files=(", bootstrap)
        self.assertNotIn("files=(", bootstrap)

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
