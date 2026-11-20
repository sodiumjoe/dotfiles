## Neovim Architecture

Entry point: `home/.config/nvim/init.lua`. Bootstraps lazy.nvim with interleaved loading:

1. `sodium.config.options`, `sodium.config.diagnostics` — before plugins
2. `lazy.setup({ import = "sodium.plugins" })` — plugin specs
3. `sodium.config.autocmds`, `sodium.config.keymaps` — after plugins
4. `sodium.config.stripe` — conditional, only in stripe repos

**Config modules** (`home/.config/nvim/lua/sodium/config/`): `options`, `keymaps`, `autocmds`, `diagnostics`, `colorscheme`, `stripe`

**Plugin specs** (`home/.config/nvim/lua/sodium/plugins/`): one file per feature category, each returns a lazy.nvim spec table or array of tables. Lazy.nvim auto-imports the directory.

**Grouped plugins**: subdirectory with `init.lua` that requires and returns individual specs (see `plugins/lsp/`).

**Extracted modules** (pure functions, testable independently):
- `home/.config/nvim/lua/sodium/markdown.lua` — markdown list prefix parsing (`get_list_prefix`, `has_text_after_prefix`)
- `home/.config/nvim/lua/sodium/agentic_utils.lua` — task parsing, slugify, state cycle tables
- `home/.config/nvim/lua/sodium/utils.lua` — keymaps, augroups, path checks, etc.

**Lockfile**: `home/.config/nvim/lazy-lock.json`

## Testing

Runner: `./test-nvim.sh` (plenary.nvim busted harness, headless). Run a single file with `./test-nvim.sh tests/neovim/agency_stream_spec.lua`. Install plugins with `:Lazy sync` before running tests. The runner loads the real configuration with plugin installation and update checks disabled, and fails if configured plugins are missing. Runtime state and caches use temporary directories.

The retained tests cover the primary Agency new-session mapping, submission and detach, ordered streaming bursts, tool and permission boundaries, completion, and a reader who scrolls away from the response. They use the fork's native session manager and widget with a controlled ACP transport. The Agency specs also cover reload, rebind, restore, stop, the pickers and folds. Helper functions, plugin declarations, configuration values and unrelated editor features do not have dedicated tests.

Agency runs on the sodiumjoe/agentic.nvim fork, branch `sodium`, which adds the extension points Agency needs and is pinned in `lazy-lock.json`. Agency's client in `home/.config/nvim/lua/sodium/agency/client.lua` is a subclass of the plugin's `ACPClient` (ADR 0005), installed through `provider_config.client_class`. The installed class is a proxy that resolves the implementation at call time, so `:AgencyReload` takes effect without restarting the editor. Each attachment has one widget, which holds the native session manager and is keyed by its `session_key` rather than by tab page, so any tab can show it. Attaching sends the native `load` request, and creating a session sends `new` with Agency's start spec in its metadata. When a binding has died, for example after a Handler restart, Agency reattaches the same session into a fresh manager. The roster and model choices come from the Handler, and discovery is explicit. See `agency/README.md` at the repository root for commands, restore behavior and limits.

The tests need the fork checkout, not the plugin copy that lazy.nvim installs. To run them against it, set `AGENTIC_NVIM_DIR`, for example `AGENTIC_NVIM_DIR=~/home/agentic.nvim/.worktrees/sodium ./test-nvim.sh tests/neovim/agency_stream_spec.lua`.

For editor changes, exercise an existing workflow case when the behavior affects these paths. Interactive UI and external provider behavior require separate manual verification. Avoid adding tests for declarations or implementation details.

Plenary workers load installed plugin paths through `minimal_init.lua`. Insert-mode `feedkeys` is unreliable in headless tests; invoke mapping callbacks directly when needed. Destroy test sessions and scratch buffers after each case to prevent editor state from leaking between cases.