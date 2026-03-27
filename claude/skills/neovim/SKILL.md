---
name: neovim-rpc
description: Interact with a running neovim instance over RPC — open files, show diffs, execute Lua. Use when you need to open a file in the user's editor, show a vimdiff, or run arbitrary Lua in neovim. Requires $NVIM or $NVIM_SOCKET_PATH to be set.
---

# Neovim RPC Commands

Three commands for interacting with a running neovim instance over its RPC socket. All require `$NVIM` or `$NVIM_SOCKET_PATH` to be set (this is automatic when running inside neovim via agentic.nvim).

## Commands

### nvim-lua

Execute arbitrary Lua in the running neovim instance.

```bash
nvim-lua '<lua-expression>'
```

The expression is wrapped in `(function() ... end)()`. Return values are printed to stdout.

Examples:

```bash
nvim-lua "return vim.fn.expand('%:p')"
nvim-lua "return require('sodium.utils').editor_window()"
nvim-lua "vim.cmd('echom \"hello\"') return 0"
```

### nvim-open

Open a file in the running neovim instance.

```bash
nvim-open --editor '<absolute-path>'
```

The `--editor` flag targets the first non-agentic window (i.e., skips windows with Agentic* filetypes). Without `--editor`, opens in whichever window is current.

You can also target a specific window by ID:

```bash
nvim-open --window <win-id> '<absolute-path>'
```

Use this after creating plan files, project files, or any file the user should see immediately.

### nvim-diff

Open a vimdiff view in the running neovim instance. Three modes based on argument count:

**Two files:**

```bash
nvim-diff <file_a> <file_b>
```

Opens both files side by side with `diffthis`.

**File vs git ref (working tree on the right):**

```bash
nvim-diff <file> <ref>
```

Shows the file at `<ref>` on the left, the working tree version on the right. The working tree buffer is editable.

**File at two git refs:**

```bash
nvim-diff <file> <ref_a> <ref_b>
```

Shows the file at two different commits in read-only scratch buffers.

The two-arg case uses a heuristic: if the second argument is an existing file path, it's treated as two-file mode; otherwise it's treated as a git ref.

All modes find the first non-agentic editor window (same as `nvim-open --editor`) and run `:only` before opening the diff.

## When to use each

| Situation | Command |
|---|---|
| Open a file for the user to read or edit | `nvim-open --editor` |
| Walk the user through changes you made | `nvim-diff <file> <before-ref> <after-ref>` |
| Show uncommitted changes | `nvim-diff <file> HEAD` |
| Compare two files | `nvim-diff <file_a> <file_b>` |
| PR review: show file diff against base | `nvim-diff <file> <base-ref> HEAD` |
| Run arbitrary neovim commands | `nvim-lua` |

## Notes

- All commands exit silently (exit 0) if no neovim socket is found, so they are safe to call unconditionally.
- File paths passed to `nvim-open` and `nvim-diff` should be absolute paths. The scripts resolve relative paths, but absolute is more reliable.
- `nvim-diff` with git refs uses `git show ref:path` internally, so the file must be tracked by git.