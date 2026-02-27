# nvim-remote

Remote Neovim control via socket. Execute Lua, open files.

## Scripts

| Script | Description |
|--------|-------------|
| `nvim-lua` | Execute arbitrary Lua in the remote Neovim instance. Returns the result to stdout. |
| `nvim-open` | Open a file in a Neovim window. Accepts `--window <id>` to target a specific window. |

## Usage

```bash
# Execute Lua and get return value
nvim-lua "return vim.api.nvim_list_wins()"

# Open a file in the current window
nvim-open /path/to/file.md

# Open a file in a specific window
nvim-open --window 1000 /path/to/file.md
```

## Setup

Scripts need the Neovim RPC socket path via `$NVIM` (or `$NVIM_SOCKET_PATH` as legacy fallback). All scripts exit silently if neither is set.

How `$NVIM` gets set depends on how you're running the scripts:

### From Neovim's built-in terminal (`:terminal`)

No setup needed. Neovim 0.9+ automatically sets `$NVIM` for all child processes spawned via `:terminal`. Any CLI tool running inside the terminal can use the scripts immediately.

### From agentic.nvim / ACP providers

Agentic uses `uv.spawn()` which does not get Neovim's automatic `$NVIM`. Add it explicitly to the provider's env table:

```lua
env = {
    NVIM = vim.v.servername,
}
```

### From a standalone CLI session (outside Neovim)

Start Neovim with a known socket path:

```bash
nvim --listen /tmp/nvim.sock
```

Then set the variable in your shell:

```bash
export NVIM=/tmp/nvim.sock
```

To make this automatic, add a fixed `--listen` path to your Neovim alias or wrapper, and export `$NVIM` in your shell profile.

Alternatively, have Neovim write its socket path to a well-known file on startup:

```lua
-- in init.lua
vim.api.nvim_create_autocmd("VimEnter", {
    callback = function()
        local f = io.open(vim.fn.expand("~/.nvim_socket"), "w")
        if f then f:write(vim.v.servername) f:close() end
    end,
})
vim.api.nvim_create_autocmd("VimLeavePre", {
    callback = function()
        os.remove(vim.fn.expand("~/.nvim_socket"))
    end,
})
```

Then in your shell profile:

```bash
export NVIM="$(cat ~/.nvim_socket 2>/dev/null)"
```

Note: the file approach doesn't handle multiple Neovim instances or crashes that skip `VimLeavePre`.

## Environment

| Variable | Priority | Description |
|----------|----------|-------------|
| `NVIM_SOCKET_PATH` | 1 (checked first) | Legacy — for backward compatibility |
| `NVIM` | 2 (fallback) | Standard Neovim socket path |

## Implementation

- `nvim-lua` uses `--remote-expr` with `luaeval()` — synchronous, returns results, safe regardless of Neovim mode.
- `nvim-open` uses `luaeval()` with `_A` argument passing for safe path handling (no string interpolation of file paths into Lua source).