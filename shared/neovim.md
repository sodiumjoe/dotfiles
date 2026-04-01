## Neovim Architecture

Entry point: `init.lua` (repo root). Bootstraps lazy.nvim with interleaved loading:

1. `sodium.config.options`, `sodium.config.diagnostics` — before plugins
2. `lazy.setup({ import = "sodium.plugins" })` — plugin specs
3. `sodium.config.autocmds`, `sodium.config.keymaps` — after plugins
4. `sodium.config.stripe` — conditional, only in stripe repos

**Config modules** (`neovim/lua/sodium/config/`): `options`, `keymaps`, `autocmds`, `diagnostics`, `colorscheme`, `stripe`

**Plugin specs** (`neovim/lua/sodium/plugins/`): one file per feature category, each returns a lazy.nvim spec table or array of tables. Lazy.nvim auto-imports the directory.

**Grouped plugins**: subdirectory with `init.lua` that requires and returns individual specs (see `plugins/lsp/`).

**Extracted modules** (pure functions, testable independently):
- `neovim/lua/sodium/markdown.lua` — markdown list prefix parsing (`get_list_prefix`, `has_text_after_prefix`)
- `neovim/lua/sodium/agentic_utils.lua` — task parsing, slugify, state cycle tables
- `neovim/lua/sodium/utils.lua` — keymaps, augroups, path checks, etc.

**Lockfile**: `lazy-lock.json` (repo root)

## Testing

Runner: `./test-nvim.sh` (plenary.nvim busted harness, headless). Run single file: `./test-nvim.sh neovim/tests/markdown_spec.lua`.

Test files live in `neovim/tests/`. `minimal_init.lua` bootstraps the subprocess with all lazy plugin paths on rtp.

**Unit tests**: `markdown_spec`, `agentic_functions_spec`, `utils_spec`, `statusline_spec` — pure function tests for extracted modules.

**Behavioral tests**: `cursor_restore_spec`, `quickfix_spec`, `markdown_behavior_spec`, `colorscheme_spec` — test autocmds and buffer-local keymaps.

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