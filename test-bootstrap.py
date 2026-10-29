#!/usr/bin/env python3
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest


REPOSITORY = pathlib.Path(__file__).resolve().parent


class DeploymentFixture(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp(prefix="dotfiles-test-", dir="/tmp"))
        self.owner = self.root / "owner"
        self.repo = self.owner / ".dotfiles"
        self.repo.mkdir(parents=True)
        self.home_tree = self.repo / "home"
        for relative in [
            "bootstrap.sh",
            "home/bin/agy",
            "home/bin/dotfiles-generate",
            "home/bin/dotfiles-reconcile",
            "home/bin/migrate-multi-env",
            "shared/base-instructions.md",
            "shared/work-tracking.md",
            "shared/neovim.md",
            "claude-overlay.md",
            "codex-overlay.md",
            "claude/settings.base.json",
            "claude/settings.work.json",
            "claude/settings.home.json",
            "claude/settings-merge.jq",
            "codex/config.base.toml",
            "Brewfile.base",
            "Brewfile.work",
            "Brewfile.home",
        ]:
            destination = self.repo / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(REPOSITORY / relative, destination)
        (self.home_tree / ".zshenv").write_text("managed shell configuration\n")
        work = self.repo / "work-cli/bin/work"
        work.parent.mkdir(parents=True)
        work.write_text("#!/bin/sh\nexit 0\n")
        work.chmod(0o755)
        (self.home_tree / "bin/work").symlink_to("../../work-cli/bin/work")

        shim_dir = self.root / "shims"
        shim_dir.mkdir()
        (shim_dir / "bash").symlink_to("/bin/bash")
        for name, content in {
            "npm": "#!/bin/sh\nexit 0\n",
            "uname": '#!/bin/sh\nprintf "%s\\n" "$DOTFILES_TEST_PLATFORM"\n',
        }.items():
            shim = shim_dir / name
            shim.write_text(content)
            shim.chmod(0o755)
        self.environment = {
            **os.environ,
            "HOME": str(self.owner),
            "NODENV_ROOT": str(self.owner / ".nodenv"),
            "DOTFILES_DIR": str(self.repo),
            "DOTFILES_TEST_PLATFORM": "Darwin",
            "PATH": f"{shim_dir}:{os.environ['PATH']}",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
        }

    def tearDown(self):
        shutil.rmtree(self.root)

    def run_bootstrap(self, environment, check=True):
        result = subprocess.run(
            ["/bin/bash", str(self.repo / "bootstrap.sh"), f"--env={environment}"],
            cwd=self.root,
            env=self.environment,
            text=True,
            capture_output=True,
        )
        if check:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def generated_state(self):
        return {
            relative: (self.repo / relative).read_bytes()
            if (self.repo / relative).is_file() else None
            for relative in [
                "Brewfile",
                "home/.claude/CLAUDE.md",
                "home/.claude/settings.json",
                "home/.codex/AGENTS.md",
                "home/.codex/config.toml",
            ]
        }

    def live_links(self):
        return {
            str(path.relative_to(self.owner)): os.readlink(path)
            for path in self.owner.rglob("*")
            if path.is_symlink() and self.repo not in path.parents
        }

    def git(self, directory, *arguments):
        result = subprocess.run(
            ["git", "-C", str(directory), *arguments],
            env=self.environment,
            text=True,
            capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout.strip()


class BootstrapTest(DeploymentFixture):
    def assert_failed_transition_is_unchanged(self, platform):
        self.environment["DOTFILES_TEST_PLATFORM"] = platform
        self.run_bootstrap("work")
        (self.home_tree / ".claude/settings.json").write_text('{"runtime": true}\n')
        (self.home_tree / ".codex/config.toml").write_text('model = "runtime-model"\n')
        (self.repo / "claude-overlay.md").write_text("changed static instructions\n")
        (self.home_tree / ".conflict").write_text("managed\n")
        conflict = self.owner / ".conflict"
        conflict.write_text("preserve this regular file\n")
        identity = (self.owner / ".dotfiles-env").read_bytes()
        generated = self.generated_state()
        links = self.live_links()

        result = self.run_bootstrap("home", check=False)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("destination conflict", result.stderr)
        with self.subTest(state="environment identity"):
            self.assertEqual((self.owner / ".dotfiles-env").read_bytes(), identity)
        with self.subTest(state="canonical generated outputs"):
            after = self.generated_state()
            changed = [path for path in generated if after[path] != generated[path]]
            self.assertEqual(changed, [])
        with self.subTest(state="live link targets"):
            self.assertEqual(self.live_links(), links)
        with self.subTest(state="live Codex configuration"):
            config = self.owner / ".codex/config.toml"
            self.assertTrue(config.is_file(), "live Codex configuration is dangling")
            self.assertEqual(config.read_bytes(), generated["home/.codex/config.toml"])
        self.assertEqual(conflict.read_text(), "preserve this regular file\n")

    def test_failed_transition_is_unchanged_on_darwin(self):
        self.assert_failed_transition_is_unchanged("Darwin")


    def test_devbox_preserves_platform_claude_settings(self):
        runtime = self.owner / ".claude/settings.json"
        runtime.parent.mkdir()
        content = '{"platform": true}\n'
        runtime.write_text(content)

        self.run_bootstrap("devbox")

        self.assertEqual(runtime.read_text(), content)
        self.assertFalse(runtime.is_symlink())
        self.assertTrue(runtime.parent.is_dir())
        self.assertFalse(runtime.parent.is_symlink())
        self.assertTrue((self.owner / ".claude/CLAUDE.md").is_symlink())
        self.assertEqual((self.owner / ".dotfiles-env").read_text(), "DOTFILES_ENV=devbox\n")

    def assert_successful_transition(self, platform):
        self.environment["DOTFILES_TEST_PLATFORM"] = platform
        self.run_bootstrap("work")
        runtime = '{"runtime": true}\n'
        (self.home_tree / ".claude/settings.json").write_text(runtime)
        (self.repo / "claude-overlay.md").write_text("new static instructions\n")
        (self.owner / "Brewfile").write_text("unmanaged home Brewfile\n")

        self.run_bootstrap("home")

        self.assertEqual((self.owner / ".dotfiles-env").read_text(), "DOTFILES_ENV=home\n")
        self.assertEqual((self.owner / ".claude/settings.json").read_text(), runtime)
        self.assertIn("new static instructions", (self.owner / ".claude/CLAUDE.md").read_text())
        for relative in [".codex/AGENTS.md", ".codex/config.toml", "bin/work"]:
            destination = self.owner / relative
            self.assertFalse(destination.exists() or destination.is_symlink(), relative)
        for relative in [".codex/AGENTS.md", ".codex/config.toml"]:
            self.assertFalse((self.home_tree / relative).exists(), relative)
        self.assertFalse((self.home_tree / "Brewfile").exists())
        self.assertEqual((self.owner / "Brewfile").read_text(), "unmanaged home Brewfile\n")
        if platform == "Darwin":
            expected = (
                (self.repo / "Brewfile.base").read_bytes()
                + b"\n"
                + (self.repo / "Brewfile.home").read_bytes()
            )
            self.assertEqual((self.repo / "Brewfile").read_bytes(), expected)
        else:
            self.assertFalse((self.repo / "Brewfile").exists())

    def test_successful_transition_on_darwin_keeps_brewfile_outside_home(self):
        self.assert_successful_transition("Darwin")


if __name__ == "__main__":
    unittest.main()