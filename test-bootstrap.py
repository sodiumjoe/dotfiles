#!/usr/bin/env python3
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
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
            timeout=30,
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


class AgencyBootstrapTest(DeploymentFixture):
    def setUp(self):
        super().setUp()
        self.node = pathlib.Path(os.environ.get("NODENV_ROOT", pathlib.Path.home() / ".nodenv")) / "versions/24.13.0/bin/node"
        self.assertTrue(self.node.is_file(), "Agency bootstrap tests require Node 24.13.0")
        shutil.copytree(REPOSITORY / "agency/dist", self.repo / "agency/dist")
        shutil.copy2(REPOSITORY / "home/bin/acp-codex", self.home_tree / "bin/acp-codex")
        node = self.owner / ".nodenv/versions/24.13.0/bin/node"
        node.parent.mkdir(parents=True)
        node.symlink_to(self.node)
        self.state = self.root.resolve() / "state"
        self.host_key = hashlib.sha256(str(self.owner).encode()).hexdigest()
        self.host_root = self.state / "agency/hosts" / self.host_key
        self.catalog = self.host_root / "catalog"
        self.profile_path = self.catalog / "providers.json"
        self.status_marker = self.root / "status-invoked"
        self.runtime = pathlib.Path("/private/tmp" if sys.platform == "darwin" else "/tmp") / f"agy-{os.getuid()}-{self.host_key[:12]}"
        self.environment.update({
            "XDG_STATE_HOME": str(self.state),
            "DOTFILES_TEST_HOST_KEY": self.host_key,
            "DOTFILES_TEST_STATUS_MARKER": str(self.status_marker),
        })
        (self.repo / "agency/dist/src/platform/host-id.js").write_text(
            'export async function readHostId() { return process.env.DOTFILES_TEST_HOST_KEY }'
        )
        (self.repo / "agency/dist/src/main.js").write_text('''import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { productionEnvironment } from "./handler/environment.js"
import { readProfiles } from "./catalog/config.js"
import { readBackendConfig } from "./agent/backend-config.js"
assert.deepEqual(process.argv.slice(2), ["status", "--json"])
await writeFile(process.env.DOTFILES_TEST_STATUS_MARKER, "invoked")
const { paths } = await productionEnvironment()
const config = await readBackendConfig(paths.persistentRoot)
const profiles = await readProfiles(paths.persistentRoot)
assert.ok(profiles.some(p => p.enabled && p.id === config.defaultBackendId))
process.stdout.write(JSON.stringify({ defaultBackendId: config.defaultBackendId }))''')
        self.adapter = self.repo / "node-bin/node_modules/@agentclientprotocol/codex-acp"
        self.adapter.mkdir(parents=True)
        (self.adapter / "package.json").write_text(json.dumps({
            "name": "@agentclientprotocol/codex-acp", "version": "1.7.0", "main": "index.js",
        }))
        (self.adapter / "index.js").write_text('throw new Error("provider execution is forbidden in bootstrap tests")')

    def tearDown(self):
        if hasattr(self, "runtime") and self.runtime.exists():
            shutil.rmtree(self.runtime)
        super().tearDown()

    def standard_profile(self):
        return {
            "id": "codex-acp", "enabled": True,
            "executable": str((self.home_tree / "bin/acp-codex").resolve()),
            "adapterPackageJson": str((self.adapter / "package.json").resolve()),
            "sdkPackageJson": None,
            "configurationFiles": [str((self.owner / ".codex/config.toml").resolve())],
        }

    def prepare_host_state(self):
        self.host_root.mkdir(parents=True, mode=0o700, exist_ok=True)
        for directory in [self.state / "agency", self.state / "agency/hosts", self.host_root]:
            directory.chmod(0o700)

    def write_profile(self, providers):
        self.prepare_host_state()
        self.catalog.mkdir(mode=0o700, exist_ok=True)
        self.profile_path.write_text(json.dumps({"version": 1, "providers": providers}))
        self.profile_path.chmod(0o600)

    def write_backend(self, compatibility_id="codex-acp-1.7"):
        self.prepare_host_state()
        self.catalog.mkdir(mode=0o700, exist_ok=True)
        backend = self.catalog / "backends.json"
        backend.write_text(json.dumps({
            "version": 1, "defaultBackendId": "codex-acp", "backends": [{
                "id": "codex-acp", "args": ["--custom"], "environmentDefaults": {},
                "initial": {"modeId": "agent-full-access"}, "compatibilityId": compatibility_id,
            }],
        }))
        backend.chmod(0o600)
        return backend

    def read_runtime(self, observe=True, check=True):
        script = '''const { readProfiles, observeConfig } = await import(process.argv[1])
const { readBackendConfig } = await import(process.argv[2])
const profiles = await readProfiles(process.argv[3])
const backends = await readBackendConfig(process.argv[3])
const profile = profiles.find(p => p.enabled && p.id === backends.defaultBackendId)
const evidence = process.argv[4] === "observe" ? await observeConfig(profile) : null
process.stdout.write(JSON.stringify({ profiles, backends, evidence }))'''
        result = subprocess.run(
            [str(self.node), "--input-type=module", "-e", script,
             (self.repo / "agency/dist/src/catalog/config.js").as_uri(),
             (self.repo / "agency/dist/src/agent/backend-config.js").as_uri(),
             str(self.host_root), "observe" if observe else "declare"],
            cwd=self.root, env=self.environment, text=True, capture_output=True, timeout=10,
        )
        if check:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            return json.loads(result.stdout)
        return result

    def run_provider_check(self):
        return subprocess.run(
            [str(self.node), str(self.repo / "agency/dist/scripts/setup-provider.js")],
            cwd=self.root, env=self.environment, text=True, capture_output=True, timeout=10,
        )

    def assert_setup_failed(self):
        result = self.run_bootstrap("devbox")
        self.assertIn("Agency setup failed", result.stderr)
        self.assertFalse(self.status_marker.exists(), result.stdout + result.stderr)

    def test_runtime_defaults_without_bootstrap(self):
        self.prepare_host_state()
        result = self.read_runtime()
        self.assertEqual(result["profiles"], [self.standard_profile()])
        self.assertEqual(result["backends"]["defaultBackendId"], "codex-acp")
        self.assertEqual(result["backends"]["backends"][0]["environmentDefaults"], {
            "INITIAL_AGENT_MODE": "agent-full-access", "MODEL_PROVIDER": "litellm",
        })
        self.assertFalse(self.catalog.exists())
        self.assertFalse(self.profile_path.exists())

    def test_runtime_defaults_with_existing_catalog(self):
        self.prepare_host_state()
        self.catalog.mkdir(mode=0o700)
        result = self.read_runtime()
        self.assertEqual(result["profiles"], [self.standard_profile()])
        self.assertEqual(list(self.catalog.iterdir()), [])

    def test_runtime_defaults_honor_backend_overrides(self):
        backend = self.write_backend()
        before = (backend.read_bytes(), backend.stat().st_ino)
        result = self.read_runtime()
        self.assertEqual(result["profiles"], [self.standard_profile()])
        self.assertEqual(result["backends"]["backends"][0]["args"], ["--custom"])
        self.assertEqual((backend.read_bytes(), backend.stat().st_ino), before)
        self.assertFalse(self.profile_path.exists())

    def test_runtime_declares_missing_adapter_and_validation_rejects_it(self):
        self.prepare_host_state()
        shutil.rmtree(self.adapter)
        result = self.read_runtime(observe=False)
        self.assertEqual(result["profiles"], [self.standard_profile()])
        checked = self.run_provider_check()
        self.assertNotEqual(checked.returncode, 0)
        self.assertFalse(self.profile_path.exists())
        self.assertFalse(self.catalog.exists())

    def test_runtime_rejects_symlinked_profile_override(self):
        self.write_profile([self.standard_profile()])
        target = self.catalog / "other.json"
        self.profile_path.rename(target)
        self.profile_path.symlink_to(target)
        before = target.read_bytes()
        result = self.read_runtime(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(self.profile_path.is_symlink())
        self.assertEqual(target.read_bytes(), before)

    def test_runtime_default_fingerprint_tracks_config_changes(self):
        self.prepare_host_state()
        first = self.read_runtime()["evidence"]["fingerprint"]
        config = self.owner / ".codex/config.toml"
        config.parent.mkdir()
        config.write_text('model = "first-model"')
        second = self.read_runtime()["evidence"]["fingerprint"]
        config.write_text('model = "second-model"')
        third = self.read_runtime()["evidence"]["fingerprint"]
        self.assertNotEqual(first, second)
        self.assertNotEqual(second, third)
        self.assertFalse(self.profile_path.exists())

    def test_runtime_defaults_follow_deployed_symlinks(self):
        self.prepare_host_state()
        config = self.owner / ".codex/config.toml"
        config.parent.mkdir()
        first_config = self.root / "first config.toml"
        second_config = self.root / "second config.toml"
        first_config.write_text('model = "same-model"')
        second_config.write_text('model = "same-model"')
        config.symlink_to(first_config)
        modules = self.repo / "node-bin/node_modules"
        first_modules = self.root / "first packages"
        second_modules = self.root / "second packages"
        modules.rename(first_modules)
        shutil.copytree(first_modules, second_modules)
        modules.symlink_to(first_modules)
        first = self.read_runtime()
        self.assertEqual(first["profiles"][0]["configurationFiles"], [str(first_config.resolve())])
        self.assertEqual(first["profiles"][0]["adapterPackageJson"], str((first_modules / "@agentclientprotocol/codex-acp/package.json").resolve()))
        config.unlink()
        config.symlink_to(second_config)
        second = self.read_runtime()
        self.assertEqual(second["profiles"][0]["configurationFiles"], [str(second_config.resolve())])
        self.assertNotEqual(first["evidence"]["fingerprint"], second["evidence"]["fingerprint"])
        modules.unlink()
        modules.symlink_to(second_modules)
        third = self.read_runtime()
        self.assertEqual(third["profiles"][0]["adapterPackageJson"], str((second_modules / "@agentclientprotocol/codex-acp/package.json").resolve()))
        self.assertNotEqual(second["evidence"]["fingerprint"], third["evidence"]["fingerprint"])
        self.assertFalse(self.profile_path.exists())

    def test_directory_config_fails_validation_without_profile_publication(self):
        config = self.owner / ".codex/config.toml"
        config.mkdir(parents=True)
        result = self.run_provider_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.profile_path.exists())
        self.assertTrue(config.is_dir())
        self.assertFalse(self.catalog.exists())

    def test_absent_config_passes_validation_without_profile_publication(self):
        result = self.run_provider_check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse((self.owner / ".codex").exists())
        self.assertFalse(self.profile_path.exists())
        self.assertFalse(self.catalog.exists())

    def test_fresh_devbox_configures_backend_before_status(self):
        result = self.run_bootstrap("devbox")
        self.assertTrue(self.status_marker.exists(), result.stdout + result.stderr)
        self.assertNotIn("Agency setup failed", result.stderr)
        self.assertEqual(self.read_runtime()["profiles"], [self.standard_profile()])
        self.assertFalse(self.profile_path.exists())

    def test_repeat_bootstrap_preserves_codex_settings_without_profile(self):
        self.run_bootstrap("devbox")
        config = self.home_tree / ".codex/config.toml"
        config.write_text('model = "my-existing-model"')
        self.status_marker.unlink()
        result = self.run_bootstrap("devbox")
        self.assertFalse(self.profile_path.exists())
        self.assertEqual(config.read_text(), 'model = "my-existing-model"')
        self.assertTrue(self.status_marker.exists(), result.stdout + result.stderr)
        self.assertNotIn("Agency setup failed", result.stderr)

    def test_custom_profile_and_backend_need_no_standard_installation(self):
        custom = self.owner / "custom tools"
        custom.mkdir()
        wrapper = custom / "codex"
        wrapper.write_text("#!/bin/sh\nexit 99")
        wrapper.chmod(0o700)
        adapter = custom / "adapter"
        shutil.move(self.adapter, adapter)
        (self.home_tree / "bin/acp-codex").unlink()
        profile = self.standard_profile()
        profile.update(executable=str(wrapper.resolve()), adapterPackageJson=str((adapter / "package.json").resolve()), configurationFiles=[])
        self.write_profile([profile])
        backend = self.write_backend()
        before = {p: (p.read_bytes(), p.stat().st_ino) for p in [self.profile_path, backend]}
        result = self.run_bootstrap("devbox")
        self.assertNotIn("Agency setup failed", result.stderr)
        self.assertTrue(self.status_marker.exists())
        for path, identity in before.items():
            self.assertEqual((path.read_bytes(), path.stat().st_ino), identity)

    def test_disabled_profile_is_preserved_without_starting_handler(self):
        profile = self.standard_profile()
        profile["enabled"] = False
        self.write_profile([profile])
        before = self.profile_path.read_bytes()
        self.assert_setup_failed()
        self.assertEqual(self.profile_path.read_bytes(), before)

    def test_empty_profile_is_preserved_without_starting_handler(self):
        self.write_profile([])
        before = self.profile_path.read_bytes()
        self.assert_setup_failed()
        self.assertEqual(self.profile_path.read_bytes(), before)

    def test_malformed_or_insecure_profile_is_never_replaced(self):
        self.write_profile([])
        for content, mode in [("malformed", 0o600), ('{"version":1,"providers":[]}', 0o644)]:
            with self.subTest(content=content, mode=mode):
                self.profile_path.write_text(content)
                self.profile_path.chmod(mode)
                self.assert_setup_failed()
                self.assertEqual(self.profile_path.read_text(), content)
                self.assertEqual(self.profile_path.stat().st_mode & 0o777, mode)

    def test_missing_or_nonexecutable_wrapper_does_not_publish_profile(self):
        wrapper = self.home_tree / "bin/acp-codex"
        wrapper.chmod(0o600)
        self.assert_setup_failed()
        self.assertFalse(self.profile_path.exists())
        wrapper.unlink()
        self.assert_setup_failed()
        self.assertFalse(self.profile_path.exists())

    def test_missing_or_unsupported_adapter_does_not_publish_profile(self):
        metadata = self.adapter / "package.json"
        for version in ["2.0.0", None]:
            with self.subTest(version=version):
                if version is None:
                    metadata.unlink()
                else:
                    data = json.loads(metadata.read_text())
                    data["version"] = version
                    metadata.write_text(json.dumps(data))
                self.assert_setup_failed()
                self.assertFalse(self.profile_path.exists())

    def test_catalog_symlink_is_preserved_and_rejected(self):
        self.write_profile([])
        target = self.host_root / "other-catalog"
        self.catalog.rename(target)
        self.catalog.symlink_to(target)
        self.assert_setup_failed()
        self.assertTrue(self.catalog.is_symlink())
        self.assertEqual(json.loads((target / "providers.json").read_text())["providers"], [])

    def test_malformed_backend_without_profile_is_preserved_and_rejected(self):
        self.write_profile([])
        self.profile_path.unlink()
        backend = self.catalog / "backends.json"
        backend.write_text("custom backend configuration")
        backend.chmod(0o600)
        self.assert_setup_failed()
        self.assertFalse(self.profile_path.exists())
        self.assertEqual(backend.read_text(), "custom backend configuration")

    def test_backend_without_profile_uses_runtime_default(self):
        backend = self.write_backend()
        before = (backend.read_bytes(), backend.stat().st_ino)
        result = self.run_bootstrap("devbox")
        self.assertNotIn("Agency setup failed", result.stderr)
        self.assertTrue(self.status_marker.exists())
        self.assertEqual((backend.read_bytes(), backend.stat().st_ino), before)
        self.assertFalse(self.profile_path.exists())

    def test_unsupported_backend_compatibility_is_preserved_and_rejected(self):
        backend = self.write_backend(compatibility_id="unknown-compatibility")
        before = backend.read_bytes()
        self.assert_setup_failed()
        self.assertEqual(backend.read_bytes(), before)
        self.assertFalse(self.profile_path.exists())

    def test_concurrent_validation_does_not_publish_profile(self):
        self.run_bootstrap("devbox")
        command = [str(self.node), str(self.repo / "agency/dist/scripts/setup-provider.js")]
        processes = [subprocess.Popen(command, env=self.environment, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(4)]
        try:
            results = [process.communicate(timeout=20) for process in processes]
            for process, (stdout, stderr) in zip(processes, results):
                self.assertEqual(process.returncode, 0, stdout + stderr)
            self.assertFalse(self.profile_path.exists())
            self.assertFalse(self.catalog.exists())
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                process.communicate(timeout=5)


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