# efm-langserver + fmt-resolve Migration

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace none-ls with efm-langserver backed by a shared `fmt-resolve` script, so neovim and claude hooks use identical formatting logic.

**Architecture:** A single bash script (`fmt-resolve`) resolves the correct formatter for any file path. Claude hooks call it via `fmt-file`. Neovim uses efm-langserver, which delegates formatting to `fmt-resolve` and provides rubocop diagnostics directly. none-ls is removed entirely.

**Tech Stack:** bash, efm-langserver (already installed at `/opt/homebrew/bin/efm-langserver`), nvim-lspconfig (already configured)

**Behavioral changes from none-ls:**
- rubocop path corrected from `scripts/bin/rubocop-daemon/rubocop` (stale, didn't exist) to `scripts/bin/rubocop-server/rubocop` (actual path). Rubocop diagnostics were silently broken; this fixes them.
- prettier activation no longer gated on `prettier.config.js` at root. Instead, `fmt-resolve` activates prettier whenever a local or system `prettier` binary is found. Broader scope, arguably better behavior.
- Ruby formatting added (was missing from claude hooks entirely).

---

### Task 1: Validate rubocop stdin+autocorrect

Standard rubocop does not support `--autocorrect` with `--stdin` — `--stdin` is diagnostic-only. Must validate before deploying the config.

**Step 1: Test rubocop stdin+autocorrect behavior**

Run (in pay-server):
```bash
echo 'x=1' | scripts/bin/rubocop-server/rubocop --autocorrect --stdin test.rb
```

Expected if it works: corrected Ruby code on stdout.
Expected if it fails: error or diagnostics-only output.

**Step 2: Based on result, choose Ruby formatting strategy**

If stdin+autocorrect works: keep current `fmt-resolve` rb case as-is.

If it doesn't: use file-based formatting for Ruby. Update the rb case in `fmt-resolve` to always use file mode (no stdin branch), and in `efm-langserver/config.yaml`, add a separate Ruby-specific formatting tool with `format-stdin: false`:

```yaml
  rubocop-format: &rubocop-format
    format-command: 'fmt-resolve --exec ${INPUT}'
    format-stdin: false
```

And change the Ruby language entry:
```yaml
  ruby:
    - <<: *rubocop-format
    - <<: *rubocop-lint
```

### Task 2: Create `fmt-resolve` script [DONE]

Already created at `~/.dotfiles/bin/fmt-resolve`. Symlinked to `~/bin/fmt-resolve`.

**Files:**
- Created: `bin/fmt-resolve`

May need revision based on Task 1 results (Ruby stdin mode).

### Task 3: Rewrite `fmt-file` [DONE]

Already rewritten to delegate to `fmt-resolve --exec`.

**Files:**
- Modified: `bin/fmt-file`

### Task 4: Create efm-langserver config [DONE]

Already created at `~/.dotfiles/efm-langserver/config.yaml`.

**Files:**
- Created: `efm-langserver/config.yaml`

May need revision based on Task 1 results (Ruby format-stdin).

### Task 5: Symlink efm-langserver config via bootstrap.sh

**Files:**
- Modify: `bootstrap.sh:27-37` (xdg_files array)

**Step 1: Add efm-langserver to xdg_files array**

```bash
xdg_files=(\
  "alacritty"\
  "efm-langserver"\
  "ghostty"\
  "hammerspoon"\
  "karabiner"\
  "rg"\
  "tmux"\
  "vivid"\
  "work"\
  "zsh"\
  )
```

**Step 2: Remove existing empty config dir and create symlink**

Run: `rmdir ~/.config/efm-langserver && ln -s ~/.dotfiles/efm-langserver ~/.config/efm-langserver`

**Step 3: Verify symlink**

Run: `ls -la ~/.config/efm-langserver/config.yaml`
Expected: shows the file via symlink chain

**Step 4: Commit**

```bash
git add bootstrap.sh efm-langserver/config.yaml
git commit -m "add efm-langserver config with fmt-resolve formatting"
```

### Task 6: Remove none-ls.lua

**Files:**
- Delete: `neovim/lua/sodium/plugins/lsp/none-ls.lua`
- Modify: `neovim/lua/sodium/plugins/lsp/init.lua:1-5`

**Step 1: Delete none-ls.lua**

Run: `rm neovim/lua/sodium/plugins/lsp/none-ls.lua`

**Step 2: Update init.lua to remove none-ls require**

Replace contents of `neovim/lua/sodium/plugins/lsp/init.lua` with:

```lua
return {
    require("sodium.plugins.lsp.nvim-lspconfig"),
    require("sodium.plugins.lsp.format-ts-errors"),
}
```

**Step 3: Check plenary.nvim dependency**

Run: `grep -r "plenary" ~/.dotfiles/neovim/lua/sodium/plugins/`

If plenary is only referenced by none-ls, it becomes orphaned. Lazy.nvim will handle this automatically (unused deps aren't loaded), but `lazy-lock.json` will still list it. No action needed unless you want to clean the lockfile.

**Step 4: Commit**

```bash
git add -u neovim/lua/sodium/plugins/lsp/none-ls.lua neovim/lua/sodium/plugins/lsp/init.lua
git commit -m "remove none-ls, formatting moves to efm-langserver"
```

### Task 7: Add efm to nvim-lspconfig

**Files:**
- Modify: `neovim/lua/sodium/plugins/lsp/nvim-lspconfig.lua:80-86` (after flow/tsgo/lua_ls configs)
- Modify: `neovim/lua/sodium/plugins/lsp/nvim-lspconfig.lua:114-122` (lsp_servers table)
- Modify: `neovim/lua/sodium/plugins/lsp/nvim-lspconfig.lua:196-199` (`<leader>f` keymap)
- Modify: `neovim/lua/sodium/config/lsp/formatting.lua` (format-on-save filter)

**Step 1: Add efm server config**

After `vim.lsp.config("lua_ls", {})` (line 85), add:

```lua
vim.lsp.config("efm", {
    cmd = { "efm-langserver" },
    filetypes = {
        "lua", "javascript", "javascriptreact", "typescript", "typescriptreact",
        "css", "json", "bzl", "ruby",
    },
    init_options = {
        documentFormatting = true,
    },
    root_markers = { ".git" },
})
```

**Step 2: Add efm to lsp_servers table**

In the `lsp_servers` table (around line 114), add:

```lua
{ "efm", "efm-langserver" },
```

**Step 3: Extract efm-aware format helper**

In `neovim/lua/sodium/config/lsp/formatting.lua`, extract a format function that prefers efm when attached. This is used by both format-on-save and the manual `<leader>f` keymap.

Replace the full file with:

```lua
local utils = require("sodium.utils")

local M = {}

local autoformat_augroup = vim.api.nvim_create_augroup("LspFormatting", { clear = true })

function M.format(bufnr)
    local efm_attached = #vim.lsp.get_clients({ bufnr = bufnr, name = "efm" }) > 0
    vim.lsp.buf.format({
        timeout_ms = 30000,
        name = efm_attached and "efm" or nil,
    })
end

function M.setup_format_on_save(client, bufnr)
    if not client:supports_method("textDocument/formatting") or utils.is_fugitive_buffer(bufnr) then
        return
    end

    vim.api.nvim_clear_autocmds({ group = autoformat_augroup, buffer = bufnr })
    vim.api.nvim_create_autocmd("BufWritePre", {
        group = autoformat_augroup,
        buffer = bufnr,
        callback = function()
            M.format(bufnr)
            vim.bo[bufnr].endofline = true
            vim.bo[bufnr].fixendofline = true
        end,
    })
end

return M
```

**Step 4: Update `<leader>f` keymap to use the shared format helper**

In `nvim-lspconfig.lua`, change the `<leader>f` keymap (around line 196) from:

```lua
{
    [[<leader>f]],
    function()
        vim.lsp.buf.format({ timeout_ms = 30000 })
    end,
},
```

to:

```lua
{
    [[<leader>f]],
    function()
        require("sodium.config.lsp.formatting").format(0)
    end,
},
```

This ensures both format-on-save and manual format use the same efm-preference logic.

**Step 5: Verify efm starts**

Run: `nvim some_file.lua`, then `:LspInfo`
Expected: efm-langserver listed as attached client

**Step 6: Commit**

```bash
git add neovim/lua/sodium/plugins/lsp/nvim-lspconfig.lua neovim/lua/sodium/config/lsp/formatting.lua
git commit -m "add efm-langserver, prefer it for formatting"
```

### Task 8: Commit fmt-resolve and fmt-file changes

**Step 1: Stage and commit the script changes**

```bash
git add bin/fmt-resolve bin/fmt-file
git commit -m "centralize formatter dispatch in fmt-resolve"
```

### Task 9: Smoke test fmt-resolve

**Step 1: Test lua formatting (print mode)**

Run: `cd ~/.dotfiles && fmt-resolve neovim/lua/sodium/utils.lua`
Expected: outputs stylua command

**Step 2: Test prettier resolution (in pay-server)**

Run: `cd ~/stripe/mint/pay-server && fmt-resolve manage/frontend/src/index.ts`
Expected: outputs prettier command with local node_modules binary

**Step 3: Test ruby resolution (in pay-server)**

Run: `cd ~/stripe/mint/pay-server && fmt-resolve lib/some_file.rb`
Expected: outputs rubocop-server command

**Step 4: Test buildifier resolution (in pay-server)**

Run: `cd ~/stripe/mint/pay-server && fmt-resolve some_file.bzl`
Expected: outputs buildifier command

**Step 5: Test unknown extension**

Run: `fmt-resolve /tmp/test.xyz; echo "exit: $?"`
Expected: no output, exit 0

**Step 6: Test stdin mode for lua**

Run: `echo 'x=1' | fmt-resolve --stdin /tmp/test.lua`
Expected: formatted lua output (`x = 1`)

### Task 10: Smoke test efm in neovim

**Step 1: Open a lua file, verify efm attaches**

Run: `nvim ~/.dotfiles/neovim/lua/sodium/utils.lua`, then `:LspInfo`
Expected: efm-langserver listed as attached client

**Step 2: Verify efm is the formatter, not lua_ls**

Run: `:lua print(#vim.lsp.get_clients({ name = "efm" }))` — should print `1`
Run: `:lua require("sodium.config.lsp.formatting").format(0)` — should format via efm without prompt

**Step 3: Test format-on-save**

Add a formatting violation (e.g. extra spaces), save with `:w`
Expected: stylua formats the file via efm

**Step 4: Test `<leader>f` manual format**

Add a formatting violation, press `<leader>f`
Expected: formats via efm without multi-client prompt

**Step 5: Test Rust file (negative test)**

Open a `.rs` file (if available), run `:LspInfo`
Expected: rust_analyzer attached, efm NOT attached. `<leader>f` formats via rust_analyzer.

**Step 6: Test rubocop diagnostics (in pay-server)**

Run: `nvim ~/stripe/mint/pay-server/lib/some_file.rb` (find a file with a rubocop violation)
Expected: diagnostics appear with source "rubocop"

**Step 7: Verify eslint auto-fix still works**

Open a `.tsx` file in pay-server with an eslint violation, save
Expected: `LspEslintFixAll` still fires (separate from efm formatting)

---

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| rubocop `--stdin` + `--autocorrect` invalid | Ruby formatting via efm broken | Validated in Task 1 before deployment; fallback to file-based |
| Multiple LSPs offering formatting | Format prompt or wrong formatter | `M.format()` helper prefers efm by name (Task 7) |
| none-ls removal breaks something | Formatting or diagnostics missing | Only 4 sources configured, all accounted for |
| rubocop lint-command uses relative path | Fails outside pay-server | `lint-ignore-exit-code: true` swallows errors; rubocop only relevant in pay-server anyway |
| efm attaches to fugitive buffers | Wasted resources | `formatting.lua` already guards format-on-save via `is_fugitive_buffer`; efm attachment is harmless |
| Double formatting on JS/TS save | eslint fix + prettier both fire | Same behavior as none-ls era; not a regression |
