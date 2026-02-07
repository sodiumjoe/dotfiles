# Neovim Plugin Configuration Refactoring Plan

## Analysis Date: 2026-02-06

## Current State

### File Structure
```
init.lua (root)                     -- Entry point, sets runtimepath
neovim/
  lua/sodium/
    plugins.lua (1129 lines)        -- All plugin specs + LSP + autocmds
    general.lua (151 lines)         -- Options, autocmds, keymaps
    statusline.lua (453 lines)      -- Lualine config + LSP progress
    utils.lua (190 lines)           -- Utility functions
```

### Loading Order
1. `init.lua` - Sets runtimepath, leader key, python paths
2. `require("sodium.plugins")` - Lazy.nvim setup, LSP, all plugins
3. `require("sodium.general")` - Options, autocmds, keymaps

### Issues
- `plugins.lua` contains mixed concerns: plugin specs, LSP config, formatting logic, autocmds
- LSP keymaps defined in plugin spec (lazy-loaded)
- Format-on-save logic inlined in plugins.lua
- Agentic file tracking hooks embedded in plugin config
- No clear separation between plugin loading and configuration

## Final Structure: Hybrid Approach

**Total**: 11 files (1 init + 3 in lsp/ + 7 category files)

```
plugins/
  init.lua                         (lazy bootstrap only, ~30 lines)
  lsp/
    nvim-lspconfig.lua             (~200 lines)
    none-ls.lua                    (~50 lines)
    format-ts-errors.lua           (~5 lines)
  lazydev.lua                      (Lua dev tools, NOT LSP, ~10 lines)
  completion.lua                   (blink.cmp, snippets, ~20 lines)
  pickers.lua                      (snacks, ~150 lines)
  agentic.lua                      (~100 lines with hooks)
  editing.lua                      (hop, retrail, automkdir, dirvish, eunuch, repeat, surround, mini.move, is.vim, ~55 lines)
  treesitter.lua                   (treesitter, context, playground, ~40 lines)
  ui.lua                           (lualine, statuscol, colorizer, lspkind, signify, conflict-marker, ~40 lines)
  git.lua                          (fugitive, ~5 lines)
  colorscheme.lua                  (sodium, lush, shipwright, ~20 lines)
```

**Dependencies**: Inline approach
- plenary.nvim specified as `dependencies = { "nvim-lua/plenary.nvim" }` in any plugin that needs it
- mini.nvim specified as `dependencies = { "echasnovski/mini.nvim" }` in mini.move spec
- No separate deps.lua file needed

### general.lua: Split into config/
- `config/options.lua` - vim options (g, o, w settings)
- `config/autocmds.lua` - autocmds (restore cursor, auto-close qf, etc)
- `config/keymaps.lua` - global keymaps
- `config/stripe.lua` - Stripe-specific utilities (conditional loading)

## Phase 0: Pre-Refactor Cleanup (Minimal)

Execute these minimal cleanups before main refactor to reduce complexity:

### 1. utils.lua Changes

**Add**:
```lua
function M.is_fugitive_buffer(bufnr)
    bufnr = bufnr or 0
    return vim.api.nvim_buf_get_name(bufnr):match("^fugitive://") ~= nil
end
```

**Remove (unused functions - confirmed via codebase search)**:
- `is_project_local()` - lines 74-84
- `find_git_ancestor()` - line 86
- `get_highest_error_severity()` - lines 90-102

**Keep**:
- `virtual_lines_format` function (still used by diagnostic_config)
- `buf_to_win` and `split_line` helpers (used by virtual_lines_format)

### 2. Create config/stripe.lua (~40 lines)

Move Stripe-specific code from general.lua:
- JavaScript/Node module resolution (LoadMainNodeModule)
- Sourcegraph URL generator + keymap
- Conditionally loaded based on directory detection

Structure:
```lua
local M = {}

function M.setup_js_module_resolution()
    -- LoadMainNodeModule vimscript
end

function M.setup_sourcegraph_keymap()
    -- <leader>l keymap
end

M.setup_js_module_resolution()
M.setup_sourcegraph_keymap()

return M
```

### 3. general.lua Cleanup

Remove ~50 lines of Stripe-specific code:
- Lines 61-78: LoadMainNodeModule
- Lines 80-108: get_sg_url function and keymap

### 4. plugins.lua Updates

**Remove local function**:
- Line 26: Remove local `is_fugitive_buffer()` function definition

**Update references** (replace with `utils.is_fugitive_buffer`):
- Line 31: `is_fugitive_buffer(bufnr)` → `utils.is_fugitive_buffer(bufnr)`
- Line 61: `is_fugitive_buffer(args.buf)` → `utils.is_fugitive_buffer(args.buf)`
- Line 764: `is_fugitive_buffer(args.buf)` → `utils.is_fugitive_buffer(args.buf)`
- Line 978: `is_fugitive_buffer(bufnr)` → `utils.is_fugitive_buffer(bufnr)`

### 5. statusline.lua Updates

**Remove local function**:
- Line 10: Remove local `is_fugitive_buffer()` function definition

**Update references** (replace with `utils.is_fugitive_buffer`):
- Line 197: `is_fugitive_buffer()` → `utils.is_fugitive_buffer()`
- Line 219: `is_fugitive_buffer()` → `utils.is_fugitive_buffer()`

### 6. Root init.lua

Add conditional require for Stripe utilities:
```lua
local in_stripe_repo = vim.fn.isdirectory("/pay/src") ~= 0 
    or vim.fn.isdirectory(vim.fn.expand("~/stripe/")) ~= 0

if in_stripe_repo then
    require("sodium.config.stripe")
end
```

**Phase 0 Summary**:
- utils.lua: +1 function (is_fugitive_buffer), -3 functions (is_project_local, find_git_ancestor, get_highest_error_severity)
- plugins.lua: -1 function definition, +4 references to utils function
- statusline.lua: -1 function definition, +2 references to utils function
- config/stripe.lua: NEW file (~50 lines)
- general.lua: -50 lines (Stripe code)

## Phase 1: Extract Config from general.lua

1. Create `config/options.lua`:
   - Extract all vim option settings from general.lua
   - vim.g, vim.o, vim.wo, vim.opt settings (~50 lines)

2. Create `config/autocmds.lua`:
   - Extract autocmds from general.lua
   - AutoCloseQFLL, RestoreCursorPos (~30 lines)

3. Create `config/keymaps.lua`:
   - Extract global keymaps from general.lua
   - Movement, path copying, etc (~40 lines)

## Phase 2: Extract Shared Dependencies

1. `utils.lua` already has `is_fugitive_buffer()` (from Phase 0)

2. Create `config/diagnostics.lua`:
   - Export `diagnostic_config` table
   - Export `window_opts` table  
   - Export `virtual_lines_config` table
   - Uses `utils.virtual_lines_format` and `utils.icons`

3. Create `config/lsp/formatting.lua`:
   - Export `setup_format_on_save(client, bufnr)` function
   - Uses `is_fugitive_buffer()` from utils

4. Create `config/lsp/keymaps.lua`:
   - Set keymaps in module (no export needed)
   - Called during plugin config phase

## Phase 3: Split Plugin Specs (Final Structure)

1. Create `plugins/` directory and `plugins/lsp/` subdirectory

2. Create `plugins/init.lua` with lazy.setup({ import = "sodium.plugins" })

3. Split plugins.lua into files per final structure above

4. Each file returns single spec or array of specs

5. Dependencies (plenary, mini.nvim) specified inline in parent plugin specs

## Phase 4: Create Plugin Spec Files

### Complete Plugin Distribution by File

**plugins/init.lua**
- Lazy.nvim bootstrap code only
- No plugin specs

**plugins/lsp/nvim-lspconfig.lua** (1 plugin)
1. neovim/nvim-lspconfig

**plugins/lsp/none-ls.lua** (1 plugin)
1. nvimtools/none-ls.nvim
   - Inline dependency: nvim-lua/plenary.nvim

**plugins/lsp/format-ts-errors.lua** (1 plugin)
1. davidosomething/format-ts-errors.nvim

**plugins/lazydev.lua** (1 plugin)
1. folke/lazydev.nvim

**plugins/completion.lua** (2 plugins)
1. saghen/blink.cmp
2. rafamadriz/friendly-snippets

**plugins/pickers.lua** (1 plugin)
1. folke/snacks.nvim

**plugins/agentic.lua** (1 plugin)
1. sodiumjoe/agentic.nvim

**plugins/editing.lua** (9 plugins)
1. smoka7/hop.nvim
2. kaplanz/nvim-retrail
3. benizi/vim-automkdir
4. justinmk/vim-dirvish
5. tpope/vim-eunuch
6. tpope/vim-repeat
7. tpope/vim-surround
8. echasnovski/mini.move
   - Inline dependency: echasnovski/mini.nvim
9. haya14busa/is.vim

**plugins/treesitter.lua** (3 plugins)
1. nvim-treesitter/nvim-treesitter
2. nvim-treesitter/nvim-treesitter-context
3. nvim-treesitter/playground

**plugins/ui.lua** (6 plugins)
1. nvim-lualine/lualine.nvim
2. luukvbaal/statuscol.nvim
3. catgoose/nvim-colorizer.lua
4. onsails/lspkind-nvim
5. mhinz/vim-signify
6. rhysd/conflict-marker.vim

**plugins/git.lua** (1 plugin)
1. tpope/vim-fugitive

**plugins/colorscheme.lua** (3 plugins)
1. sodiumjoe/sodium.nvim
2. rktjmp/lush.nvim
3. rktjmp/shipwright.nvim

**Total: 33 plugins across 11 files**

## Phase 5: Update plugins/init.lua

1. Move lazy.nvim bootstrap from old plugins.lua
2. Setup call: `require("lazy").setup({ import = "sodium.plugins" }, opts)`
3. Move lockfile path and performance.rtp to opts
4. No plugin specs in init.lua itself

## Phase 6: Update Root init.lua

Replace requires with new structure:
```lua
-- Options must load first
require("sodium.config.options")

-- Diagnostics before plugins
require("sodium.config.diagnostics")

-- Plugins
require("sodium.plugins")

-- Autocmds and keymaps after plugins
require("sodium.config.autocmds")
require("sodium.config.keymaps")

-- Stripe utilities (conditional)
local in_stripe_repo = vim.fn.isdirectory("/pay/src") ~= 0 
    or vim.fn.isdirectory(vim.fn.expand("~/stripe/")) ~= 0
if in_stripe_repo then
    require("sodium.config.stripe")
end
```

## Phase 7: Cleanup

1. Remove old `neovim/lua/sodium/plugins.lua`
2. Remove old `neovim/lua/sodium/general.lua`
3. Test: LSP attach, format-on-save, diagnostics, agentic hooks
4. Test: Options, autocmds, keymaps still work
5. Verify no breaking changes

## Modern Idiomatic Patterns (Neovim 0.11.5 / 2026)

### 1. Modular File Structure (Final)
```
init.lua (root)                     -- Keep as-is
neovim/lua/sodium/
  plugins/
    init.lua                        -- lazy.nvim bootstrap only
    lsp/
      nvim-lspconfig.lua
      none-ls.lua
      format-ts-errors.lua
    lazydev.lua
    completion.lua
    pickers.lua
    agentic.lua
    editing.lua
    treesitter.lua
    ui.lua
    git.lua
    colorscheme.lua
  config/
    options.lua
    autocmds.lua
    keymaps.lua
    stripe.lua                      -- conditional loading
    diagnostics.lua
    lsp/
      formatting.lua
      keymaps.lua
  statusline.lua                    -- improved API
  utils.lua                         -- cleaned up
```

### 2. Plugin Spec Organization

Modern lazy.nvim pattern:
```lua
-- plugins/init.lua
require("lazy").setup({
  { import = "sodium.plugins" },
}, opts)

-- plugins/lsp/nvim-lspconfig.lua
return {
  {
    "neovim/nvim-lspconfig",
    dependencies = { ... },
    config = function()
      require("sodium.config.lsp")
    end,
  },
}
```

### 3. LSP Configuration Updates

Modern vim.lsp.config API (0.11+):
- Use `vim.lsp.config()` instead of direct lspconfig setup
- Use `vim.lsp.enable()` for bulk enabling
- Leverage LspAttach autocommand for keymaps
- Use native `vim.lsp.buf.format()` with autocmd

### 4. Separation of Concerns

Extract distinct modules:
- LSP server configurations
- Formatting logic (dedicated module)
- Agentic.nvim file tracking (isolated)
- Diagnostic configuration
- Fugitive buffer detection utilities

### 5. Configuration Loading Order

```
init.lua
  → config/options.lua
  → config/diagnostics.lua
  → plugins/init.lua
    → plugins/*.lua (lazy-loaded)
  → config/autocmds.lua
  → config/keymaps.lua
  → config/stripe.lua (conditional)
```

## Plugin Interdependencies

### Direct Dependencies (handled by lazy.nvim)
```lua
blink.cmp → nvim-lspconfig (get_lsp_capabilities)
lazydev.nvim → lazy.nvim (library path)
format-ts-errors.nvim → nvim-lspconfig (used in handlers)
```

### Shared Function Dependencies
```lua
-- Format-on-save function used by:
- nvim-lspconfig (LspAttach autocmd)
- none-ls (on_attach callback)

-- is_fugitive_buffer() used by:
- nvim-lspconfig (disable diagnostics)
- nvim-retrail (excluded from trim)
- none-ls (should_attach)
- Format-on-save logic

-- Diagnostic config used by:
- nvim-lspconfig (vim.diagnostic.config call)
- LSP attach logic
```

### Load Order Dependencies
```
1. diagnostic_config → must exist before vim.diagnostic.config()
2. utils.virtual_lines_format → used in diagnostic_config
3. format-on-save function → used in LspAttach autocmd
4. is_fugitive_buffer() → used in multiple plugin configs
5. statusline.on_attach() → called from LSP on_attach
```

## Migration Risk Areas

1. **Diagnostic config timing** - must load before LSP plugins
2. **Format-on-save function** - shared between lspconfig and none-ls
3. **is_fugitive_buffer()** - utility used in 4+ places
4. **Agentic file tracking** - state management across hook boundaries
5. **Statusline LSP integration** - called from lspconfig on_attach
6. **None-ls setup** - depends on format-on-save function and is_fugitive_buffer
7. **Virtual lines format** - function reference in diagnostic config

## Benefits

1. **Maintainability**: Each file has single responsibility
2. **Performance**: Lazy loading more granular
3. **Debuggability**: Clear file-to-feature mapping
4. **Extensibility**: Easy to add/remove features
5. **Standards Compliance**: Follows lazy.nvim best practices
6. **Native APIs**: Uses modern Neovim 0.11+ features

## Compatibility Notes

- Requires Neovim 0.11+ for `vim.lsp.config()` API
- Current version (0.11.5) supports all proposed patterns
- Lazy.nvim spec structure unchanged
- All existing keymaps preserved

## References

- lazy.nvim: https://github.com/folke/lazy.nvim
- vim.lsp.config: `:h vim.lsp.config()`
- LspAttach: `:h LspAttach`
- Modern examples: LazyVim, NvChad (2026 versions)

## Changelog

### 2026-02-06 - Initial Planning
- Analyzed current structure
- Evaluated 4 organization strategies
- Selected hybrid approach with 11 files
- Defined Phase 0 cleanup tasks
- Integrated pre-refactor cleanup plan

### 2026-02-06 - Revision Based on Codebase Analysis
- Updated file sizes: plugins.lua is 1129 lines (not 896), general.lua is 151 lines (not 119)
- Confirmed unused functions in utils.lua via codebase search
- Found duplicate is_fugitive_buffer() in statusline.lua (not mentioned in original plan)
- Added statusline.lua updates to Phase 0
- Removed autocmd cleanup (already removed by user)
- Removed commented code cleanup (already clean)
- Added line numbers for all is_fugitive_buffer references
- Updated Phase 0 summary with actual changes

### 2026-02-06 - Phase 0 Complete
- Added is_fugitive_buffer() to utils.lua
- Removed unused functions from utils.lua (is_project_local, find_git_ancestor, get_highest_error_severity)
- Removed local is_fugitive_buffer() from plugins.lua and statusline.lua
- Updated 4 references in plugins.lua to use utils.is_fugitive_buffer
- Updated 2 references in statusline.lua to use utils.is_fugitive_buffer
- Created config/stripe.lua with Stripe-specific code
- Removed Stripe code from general.lua (~50 lines)
- Updated root init.lua to conditionally load config/stripe.lua

### 2026-02-06 - Phase 1 Complete
- Created config/options.lua with vim options (~45 lines)
- Created config/autocmds.lua with autocmds (~10 lines)
- Created config/keymaps.lua with global keymaps (~15 lines)
- Removed general.lua

### 2026-02-06 - Phase 2 Complete
- Created config/diagnostics.lua with diagnostic_config, window_opts, virtual_lines_config
- Created config/lsp/formatting.lua with setup_format_on_save function
- Created config/lsp/keymaps.lua with LSP keymaps

### 2026-02-06 - Phase 3 Complete
- Created plugins/ and plugins/lsp/ directories

### 2026-02-06 - Phase 4 Complete
- Created plugins/lsp/nvim-lspconfig.lua (LSP server configurations)
- Created plugins/lsp/none-ls.lua (null-ls formatters/linters)
- Created plugins/lsp/format-ts-errors.lua (TypeScript error formatter)
- Created plugins/lazydev.lua (Lua development tools)
- Created plugins/completion.lua (blink.cmp + friendly-snippets)
- Created plugins/pickers.lua (snacks.nvim picker config)
- Created plugins/agentic.lua (agentic.nvim with hooks)
- Created plugins/editing.lua (hop, retrail, automkdir, dirvish, eunuch, repeat, surround, mini.move, is.vim)
- Created plugins/treesitter.lua (treesitter, context, playground)
- Created plugins/ui.lua (lualine, statuscol, colorizer, lspkind, signify, conflict-marker)
- Created plugins/git.lua (fugitive)
- Created plugins/colorscheme.lua (sodium, lush, shipwright)

### 2026-02-06 - Phase 5 Complete
- Created plugins/init.lua with lazy.nvim bootstrap and setup
- Import spec set to "sodium.plugins" to auto-load all plugin files

### 2026-02-06 - Phase 6 Complete
- Updated root init.lua with proper loading order:
  1. config/options.lua
  2. config/diagnostics.lua
  3. plugins (auto-loads all plugin specs)
  4. config/lsp/keymaps.lua
  5. config/autocmds.lua
  6. config/keymaps.lua
  7. config/stripe.lua (conditional)

### 2026-02-06 - Phase 7 Complete
- Removed old plugins.lua
- Created all config files in config/ directory
- Verified final structure:
  - 5 directories
  - 22 files total
  - config/ (7 files: options, autocmds, keymaps, diagnostics, stripe, lsp/formatting, lsp/keymaps)
  - plugins/ (13 plugin spec files + init.lua)
  - statusline.lua and utils.lua (unchanged)

### Final Structure
```
neovim/lua/sodium/
  config/
    options.lua
    autocmds.lua
    keymaps.lua
    diagnostics.lua
    stripe.lua
    lsp/
      formatting.lua
      keymaps.lua
  plugins/
    init.lua
    lsp/
      nvim-lspconfig.lua
      none-ls.lua
      format-ts-errors.lua
    lazydev.lua
    completion.lua
    pickers.lua
    agentic.lua
    editing.lua
    treesitter.lua
    ui.lua
    git.lua
    colorscheme.lua
  statusline.lua
  utils.lua
```

### 2026-02-06 - Fix: Plugin Loading
- Moved lazy.nvim bootstrap and setup from plugins/init.lua to root init.lua
- plugins/init.lua now returns empty table (required for lazy.nvim import system)
- This fixes "Expected a `table` of specs, but a `nil` was returned instead" error

### 2026-02-06 - Fix: LSP Keymaps
- Moved LSP keymaps back to plugins/lsp/nvim-lspconfig.lua keys definition
- Removed config/lsp/keymaps.lua (keymaps should be lazy-loaded with the plugin)
- Removed require("sodium.config.lsp.keymaps") from root init.lua
- LSP keymaps are now properly lazy-loaded with the nvim-lspconfig plugin

### 2026-02-06 - Fix: LSP Dependencies
- Added dependencies to nvim-lspconfig: blink.cmp, lspkind-nvim
- Removed duplicate vim.diagnostic.config() call from nvim-lspconfig.lua
- Diagnostic config is now only set once in config/diagnostics.lua

### 2026-02-06 - Fix: LSP Plugin Discovery
- **Root Cause**: lazy.nvim's `{ import = "sodium.plugins" }` doesn't recursively import subdirectories
- **Solution**: Created plugins/lsp/init.lua that returns array of specs (following LazyVim pattern)
- plugins/lsp/init.lua requires and returns all LSP plugin specs:
  - nvim-lspconfig.lua
  - none-ls.lua
  - format-ts-errors.lua
- This is the idiomatic way per lazy.nvim docs and LazyVim reference implementation

### Final Structure (Corrected)
```
neovim/lua/sodium/
  config/
    options.lua
    autocmds.lua
    keymaps.lua
    diagnostics.lua
    stripe.lua
    lsp/
      formatting.lua
  plugins/
    init.lua (returns {})
    lsp/
      init.lua (returns array of LSP specs)
      nvim-lspconfig.lua
      none-ls.lua
      format-ts-errors.lua
    lazydev.lua
    completion.lua
    pickers.lua
    agentic.lua
    editing.lua
    treesitter.lua
    ui.lua
    git.lua
    colorscheme.lua
  statusline.lua
  utils.lua
```

### 2026-02-06 - Fix: Diagnostic Signs in Status Column
- Added empty `signs.text` config to diagnostic_config
- This prevents diagnostic sign text from showing while keeping line number highlighting
- Diagnostic signs now only highlight the line number (numhl) without showing text

### 2026-02-06 - Cleanup: Remove Unnecessary init.lua
- Removed plugins/init.lua (was returning empty table)
- Per lazy.nvim docs, init.lua is optional and only needed for shared specs
- All plugin specs are auto-discovered from *.lua files in plugins/ directory

### 2026-02-06 - Move Treesitter Keymap
- Moved `<leader>h` keymap from config/keymaps.lua to treesitter plugin spec
- This keymap inspects treesitter captures and LSP highlights (debug tool)
- Now properly lazy-loaded with nvim-treesitter instead of loading at startup

### Refactoring Complete
All phases executed successfully. Configuration is now modular and follows modern Neovim/lazy.nvim patterns.