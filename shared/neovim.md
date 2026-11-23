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

## Agency Layout

Agency uses the plugin's `stacked` widget position (`plugins/agentic.lua`), which puts the chat above the input at full width. The screen has three states, and `sodium/agency/screen.lua` derives them from the live windows in the current tab instead of storing them. In Conversation, the widget is visible and the tab has no other split. In Split, the widget is visible and a document window sits above it at 50% of the editor height, held there with `winfixheight`. In Document, the widget is hidden while its session keeps running.

`<leader>ac` cycles Conversation, then Split, then Document, then back to Conversation. Going from Document to Conversation shows the widget again and closes every non-widget split in the tab, including quickfix, terminal, diff and user splits, so use it when nothing else in the tab needs to stay open. When the tab has no session, `<leader>ac` attaches or creates one as before. New sessions keep the current state, and adding context from Document shows the widget again, which puts the tab in Split. The document stays at 50% on `VimResized` and on `<leader>a=`.

`screen.lua` also owns the document window. Opening a file from the chat with `gf` or `<CR>`, confirming a Snacks picker jump, confirm or edit action, choosing from the project and task pickers, the diff and review flows, and `nvim-open --editor` all go through it, so files open in the document window and never replace the chat. If no document window exists, it creates one above the widget, at 50% when the widget is visible.

Annotations (`sodium/annotations.lua`) are in-memory notes on line ranges, shown as italic virtual lines under the range with a gutter icon on its first line, and lost on restart. `<leader>cc` adds or edits one on the current line or the visual selection, `<leader>cn` and `<leader>cp` jump between them, `<leader>cd` deletes the one under the cursor, and `<leader>cl` lists them in a Snacks picker that previews each range and jumps to it in the document window. `<leader>ai` sends them all to the current session with the prompt "Address each captured annotation.". When the Handler accepts the prompt, the sent annotations that have not changed since are cleared, and the layout switches from Split or Document to Conversation if the tab and session are still the ones in use when it was sent. Sending from Split switches to Conversation by closing the other splits in the tab, like `<leader>ac` from Document, including review diff windows. On rejection, the annotations and the layout stay and the error is reported. Annotations do not follow line changes when a file is reloaded from disk (autoread or `:checktime`), and `:e!` drops them.

## Testing

Runner: `./test-nvim.sh` (plenary.nvim busted harness, headless). Run a single file with `./test-nvim.sh tests/neovim/agency_stream_spec.lua`. Install plugins with `:Lazy sync` before running tests. The runner loads the real configuration with plugin installation and update checks disabled, and fails if configured plugins are missing. Runtime state and caches use temporary directories.

The retained tests cover the primary Agency new-session mapping, submission and detach, ordered streaming bursts, tool and permission boundaries, completion, and a reader who scrolls away from the response. They use the fork's native session manager and widget with a controlled ACP transport. The Agency specs also cover reload, rebind, restore, stop, the pickers and thinking folds. Helper functions, plugin declarations, configuration values and unrelated editor features do not have dedicated tests.

Agency depends on extension points in the sodiumjoe/agentic.nvim fork, branch `sodium`. The plugin spec uses `sodiumjoe/agentic.nvim` on branch `sodium`, pinned in `lazy-lock.json`, and `AGENTIC_NVIM_DIR` points the tests and the editor at a local fork checkout for development. Agency's client, `sodium.agency.client` in `home/.config/nvim/lua/sodium/agency/client.lua`, is a subclass of the plugin's `ACPClient` (ADR 0005), installed through `require("agentic.config").acp_providers.agency.client_class`. The installed class is a proxy that resolves the implementation at call time, so `:AgencyReload` takes effect without restarting the editor. Each attachment has one native session manager, which owns its widget and is keyed by its `session_key` rather than by tab page, so any tab can show it. Attaching sends the native `load` request, and creating a session sends `new` with Agency's start spec in its metadata. When a binding has died, for example after a Handler restart, Agency reattaches the same session into a fresh manager. The roster and model choices come from the Handler, and discovery is explicit. See `agency/README.md` at the repository root for commands, restore behavior and limits.

The tests need the fork checkout, not the plugin copy that lazy.nvim installs. To run them against it, set `AGENTIC_NVIM_DIR`, for example `AGENTIC_NVIM_DIR=~/home/agentic.nvim/.worktrees/sodium ./test-nvim.sh tests/neovim/agency_stream_spec.lua`.

For editor changes, exercise an existing workflow case when the behavior affects these paths. Interactive UI and external provider behavior require separate manual verification. Avoid adding tests for declarations or implementation details.

Plenary workers load installed plugin paths through `minimal_init.lua`. Insert-mode `feedkeys` is unreliable in headless tests; invoke mapping callbacks directly when needed. Destroy test sessions and scratch buffers after each case to prevent editor state from leaking between cases.