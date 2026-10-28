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

    def test_failed_transition_is_unchanged_on_linux(self):
        self.assert_failed_transition_is_unchanged("Linux")

    def test_new_generated_destination_conflict_prevents_initial_install(self):
        runtime = self.owner / ".claude/settings.json"
        runtime.parent.mkdir()
        runtime.write_text('{"unmanaged": true}\n')

        result = self.run_bootstrap("work", check=False)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("destination conflict", result.stderr)
        with self.subTest(state="environment identity"):
            self.assertFalse((self.owner / ".dotfiles-env").exists())
        with self.subTest(state="canonical generated outputs"):
            self.assertTrue(all(value is None for value in self.generated_state().values()))
        self.assertEqual(runtime.read_text(), '{"unmanaged": true}\n')
        self.assertEqual(self.live_links(), {})

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

    def test_successful_transition_on_linux_preserves_mutable_settings(self):
        self.assert_successful_transition("Linux")


class AgencyBootstrapTest(DeploymentFixture):
    def setUp(self):
        super().setUp()
        self.environment["DOTFILES_TEST_PLATFORM"] = "Linux"
        self.environment["NODE_ENV"] = "production"
        self.calls = self.root / "agency-calls"
        self.environment["DOTFILES_TEST_CALLS"] = str(self.calls)
        self.calls.write_text("")
        self.node_bin = self.owner / ".nodenv/versions/24.13.0/bin"
        self.node_bin.mkdir(parents=True)
        self.write_executable(
            self.node_bin / "node",
            '#!/bin/sh\n'
            'printf "agy %s\\n" "$*" >> "$DOTFILES_TEST_CALLS"\n'
            'exit "${DOTFILES_TEST_STATUS_EXIT:-0}"\n',
        )
        self.write_executable(
            self.root / "shims/npm",
            '#!/bin/sh\n'
            'printf "tools npm %s\\n" "$*" >> "$DOTFILES_TEST_CALLS"\n',
        )
        self.write_executable(
            self.node_bin / "npm",
            '#!/bin/sh\n'
            'printf "agency npm %s\\n" "$*" >> "$DOTFILES_TEST_CALLS"\n'
            'printf "runtime %s\\n" "$(command -v node)" >> "$DOTFILES_TEST_CALLS"\n'
            'if [ "$1" = "$DOTFILES_TEST_FAIL_NPM" ]; then exit 1; fi\n'
            'if [ "$1 $2" = "run build" ]; then\n'
            '  mkdir -p agency/dist/src\n'
            '  touch agency/dist/src/main.js\n'
            'fi\n',
        )
        self.environment["DOTFILES_TEST_FAIL_NPM"] = ""

    def write_executable(self, path, content):
        path.write_text(content)
        path.chmod(0o755)

    def startup_call(self):
        return f"agy {self.repo.resolve()}/agency/dist/src/main.js status --json"

    def test_devbox_builds_with_pinned_node_before_starting_handler(self):
        self.environment.pop("NODENV_ROOT")
        self.run_bootstrap("devbox")

        self.assertEqual(self.calls.read_text().splitlines(), [
            "tools npm install --prefix node-bin",
            "tools npm run sync-bins --prefix node-bin",
            "agency npm ci --include=dev --prefix agency",
            f"runtime {self.node_bin}/node",
            "agency npm run build --prefix agency",
            f"runtime {self.node_bin}/node",
            self.startup_call(),
        ])

    def test_other_environments_do_not_build_or_start_agency(self):
        for environment in ["work", "home"]:
            with self.subTest(environment=environment):
                self.calls.write_text("")
                self.run_bootstrap(environment)
                self.assertNotIn("agency npm", self.calls.read_text())
                self.assertNotIn("agy ", self.calls.read_text())

    def test_repeated_bootstrap_uses_status_and_preserves_provider_settings(self):
        profile = self.owner / ".local/state/agency/hosts/existing/catalog/providers.json"
        profile.parent.mkdir(parents=True)
        content = '{"version":1,"providers":[]}'
        profile.write_text(content)
        profile.chmod(0o600)

        self.run_bootstrap("devbox")
        self.run_bootstrap("devbox")

        self.assertEqual(profile.read_text(), content)
        self.assertEqual(profile.stat().st_mode & 0o777, 0o600)
        agy_calls = [line for line in self.calls.read_text().splitlines() if line.startswith("agy ")]
        self.assertEqual(agy_calls, [self.startup_call(), self.startup_call()])

    def test_missing_pinned_node_warns_and_preserves_dotfile_setup(self):
        (self.node_bin / "node").unlink()

        result = self.run_bootstrap("devbox")

        self.assertIn("Node 24.13.0", result.stderr)
        self.assertIn("./bootstrap.sh --env=devbox", result.stderr)
        self.assertNotIn("agency npm", self.calls.read_text())
        self.assertNotIn("agy ", self.calls.read_text())
        self.assertTrue((self.owner / "bin/agy").is_symlink())
        self.assertEqual((self.owner / ".dotfiles-env").read_text(), "DOTFILES_ENV=devbox\n")

    def test_dependency_failure_does_not_build_or_start(self):
        self.environment["DOTFILES_TEST_FAIL_NPM"] = "ci"

        result = self.run_bootstrap("devbox")

        self.assertIn("Agency setup failed", result.stderr)
        self.assertNotIn("agency npm run build", self.calls.read_text())
        self.assertNotIn("agy ", self.calls.read_text())

    def test_build_failure_does_not_start_stale_build(self):
        self.environment["DOTFILES_TEST_FAIL_NPM"] = "run"
        main = self.repo / "agency/dist/src/main.js"
        main.parent.mkdir(parents=True)
        main.write_text("stale build")

        result = self.run_bootstrap("devbox")

        self.assertIn("Agency setup failed", result.stderr)
        self.assertIn("agency npm run build", self.calls.read_text())
        self.assertNotIn("agy ", self.calls.read_text())
        self.assertEqual(main.read_text(), "stale build")

    def test_startup_failure_warns_without_failing_dotfile_setup(self):
        self.environment["DOTFILES_TEST_STATUS_EXIT"] = "69"

        result = self.run_bootstrap("devbox")

        self.assertIn(self.startup_call(), self.calls.read_text())
        self.assertIn("Agency setup failed", result.stderr)
        self.assertIn("./bootstrap.sh --env=devbox", result.stderr)

    def test_custom_nodenv_root_with_spaces(self):
        custom = self.owner / "custom nodenv"
        (self.owner / ".nodenv").rename(custom)
        self.environment["NODENV_ROOT"] = str(custom)

        self.run_bootstrap("devbox")

        self.assertIn(f"runtime {custom}/versions/24.13.0/bin/node", self.calls.read_text())
        self.assertIn(self.startup_call(), self.calls.read_text())


class LegacyMigrationTest(DeploymentFixture):
    def test_fetched_script_migrates_dirty_tracked_legacy_configs(self):
        upstream = self.root / "upstream"
        self.repo.rename(upstream)
        legacy = {
            "claude/settings.json": '{"legacy": true}\n',
            "codex/config.toml": 'model = "legacy"\n',
            "Brewfile": 'brew "legacy"\n',
        }
        for relative, content in legacy.items():
            (upstream / relative).write_text(content)
        self.git(upstream, "init", "-b", "master")
        self.git(upstream, "config", "user.name", "Migration test")
        self.git(upstream, "config", "user.email", "migration@example.invalid")
        self.git(upstream, "add", "--", *legacy)
        self.git(upstream, "commit", "-m", "legacy tracked configuration")
        self.git(self.root, "clone", str(upstream), str(self.repo))
        self.git(self.repo, "config", "pull.ff", "only")

        for relative in legacy:
            (upstream / relative).unlink()
        (upstream / ".gitignore").write_text(
            "/Brewfile\n/home/.claude/CLAUDE.md\n/home/.claude/settings.json\n"
            "/home/.codex/AGENTS.md\n/home/.codex/config.toml\n"
        )
        self.git(upstream, "add", "-A", "--", ".")
        self.git(upstream, "commit", "-m", "canonical home configuration")
        new_head = self.git(upstream, "rev-parse", "HEAD")

        modified = {
            "claude/settings.json": '{"runtime_permission": "preserve"}\n',
            "codex/config.toml": 'model = "runtime-choice"\n',
            "Brewfile": 'brew "runtime-tool"\n',
        }
        for relative, content in modified.items():
            (self.repo / relative).write_text(content)
        self.git(self.repo, "add", "--", "claude/settings.json")
        for old, deployed in [
            ("claude/settings.json", ".claude/settings.json"),
            ("codex/config.toml", ".codex/config.toml"),
        ]:
            link = self.owner / deployed
            link.parent.mkdir()
            link.symlink_to(self.repo / old)
        (self.owner / ".dotfiles-env").write_text("DOTFILES_ENV=work\n")
        self.git(self.repo, "fetch", "origin")
        downloaded = self.root / "migrate"
        downloaded.write_text(
            self.git(self.repo, "show", "origin/master:home/bin/migrate-multi-env")
        )
        environment = {
            key: value for key, value in self.environment.items()
            if key != "DOTFILES_DIR"
        }

        result = subprocess.run(
            ["/bin/bash", str(downloaded)],
            cwd=self.root,
            env=environment,
            text=True,
            capture_output=True,
        )

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.git(self.repo, "rev-parse", "HEAD"), new_head)
        self.assertEqual(self.git(self.repo, "status", "--porcelain"), "")
        backup = self.owner / ".dotfiles-migration-backup"
        for relative, content in modified.items():
            saved = backup / relative.replace("/", "_")
            self.assertEqual(saved.read_text(), content)
        for relative in [".claude/settings.json", ".codex/config.toml"]:
            live = self.owner / relative
            self.assertTrue(live.is_file(), relative)
            self.assertEqual(live.resolve(), (self.home_tree / relative).resolve())
        self.assertIn("claude_settings.json", result.stdout)
        self.assertIn("codex_config.toml", result.stdout)
        self.assertIn("home/.claude/settings.json)", result.stdout)
        self.assertIn('home/.codex/config.toml\n', result.stdout)


if __name__ == "__main__":
    unittest.main()