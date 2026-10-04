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

Runner: `./test-nvim.sh` (plenary.nvim busted harness, headless). Run single file: `./test-nvim.sh tests/neovim/markdown_spec.lua`.

Test files live in `tests/neovim/`. `minimal_init.lua` bootstraps the subprocess with all lazy plugin paths on rtp.

Agency composes the pinned Agentic UI components in `home/.config/nvim/lua/sodium/agency/`, without native provider/session constructors. One agy attachment shares bounded conversation state across independent tab views. The local roster and model choices use the Handler; discovery is explicit. Native saved-session restore remains separate. See `agency/README.md` for commands, delivery inspection, read-only capability, and retention/restore limits.

`npm run test:neovim-integration` in `agency/` owns fake Handler/provider and headless editor subprocesses, supplies an explicit private fixture CLI, and exercises real transport and UI components. Its editor loads no user init, history, provider credentials, or production hooks. Tests cover busy detach, cancellation, exact-directory inventory, UTF-8 fragmentation, complete native replay and overflow, and live visible/hidden retention. The deterministic package gate and `./test-nvim.sh` also cover native coexistence, mappings, annotations, review, and statusline.

**Unit tests**: `markdown_spec`, `agentic_functions_spec`, `utils_spec`, `statusline_spec`, `review_spec` — pure function tests for extracted modules.

**Behavioral tests**: `cursor_restore_spec`, `quickfix_spec`, `markdown_behavior_spec`, `colorscheme_spec`, `review_spec` — test autocmds, buffer-local keymaps, and review session behavior.

**Registry tests**: `keymaps_spec` (core + plugin keymap declarations), `plugins_spec` (all expected plugins declared in specs).

**Planning requirement**: every implementation plan that touches neovim code must include a testing section. Decide which category applies and describe what tests to add:
- New extracted module or pure function → unit tests
- New autocmd, keymap callback, or window behavior → behavioral test
- New keymap declaration or plugin spec → registry test entry
- If the change is untestable in headless plenary (e.g. requires interactive UI, external plugin runtime), state why explicitly

Caveats:
- Plenary subprocess doesn't fully initialize lazy.nvim plugins. Tests that need plugin side-effects (e.g. colorscheme augroups) must call the config function directly or `require` the spec module.
- Insert-mode `feedkeys` is unreliable in headless. CR continuation tests invoke the callback directly from the buffer-local keymap table.
- Window state leaks between tests in plenary. Create scratch buffers with `nvim_create_buf(false, true)` and delete them with `nvim_buf_delete(buf, { force = true })` in each test. Do not rely on `before_each`/`after_each` for window cleanup.
- To test a local function from a plugin spec, extract the callback via the spec's `keys` table (e.g. find the entry matching the keymap lhs and call its function directly).
