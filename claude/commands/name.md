---
description: Set a descriptive name for the current tmux window
allowed-tools: Bash(tmux:*), AskUserQuestion
---

# Name

Set or clear a descriptive label on the current tmux window.

## Steps

### 1. Get label

If the user provided a label in their message, use it. Otherwise, use `AskUserQuestion` to ask for a short label (1-3 words).

If the user says "clear" or similar, clear the label instead.

### 2. Set label

Set: `tmux label '<label>'`
Clear: `tmux unlabel`