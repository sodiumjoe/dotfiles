# nvim-remote

Remote Neovim control via socket. Execute Lua, open files.

Requires `$NVIM_SOCKET_PATH` to be set (e.g. by agentic.nvim). All scripts exit silently if the variable is unset.

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

## Environment

| Variable | Description |
|----------|-------------|
| `NVIM_SOCKET_PATH` | Path to the Neovim RPC socket (e.g. `vim.v.servername`) |

## Implementation

- `nvim-lua` uses `--remote-expr` with `luaeval()` — synchronous, returns results, safe regardless of Neovim mode.
- `nvim-open` uses `luaeval()` with `_A` argument passing for safe path handling (no string interpolation of file paths into Lua source).