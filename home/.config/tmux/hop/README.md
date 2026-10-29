# Hop for tmux

This local fork uses the Python grouping and ANSI style implementation from
[tmux-easy-motion](https://github.com/IngoMeyer441/tmux-easy-motion), pinned at
`1a1aca6ed82b6b02dbfee99e0125540b6f590743` (2026-07-16). The original Python file
and license are preserved verbatim in `vendor/`. The upstream shell wrappers,
FIFO transport, and pane-swapping code are omitted.

The adapter uses Python 3 and tmux 3.7 or newer. It adds visible word and
case-insensitive Python-regex targets, ranks them by Hop's weighted Manhattan
distance, and uses Hop's alphabet and the sodium colors. Exact Vim-regex syntax
and complex emoji grapheme widths are not supported.

## Controls

Press `Ctrl-a e w` to label visible word starts. Press `Ctrl-a e /`, type a
pattern, then press Enter to label its matches. Type the label to jump. A sole
match jumps immediately. Escape or Ctrl-c cancels; an invalid hint key also
cancels. In the pattern prompt, Backspace edits and Ctrl-u clears the input.
Invalid patterns and patterns with no matches stay in the prompt for editing.
An empty pattern followed by Enter cancels.

Successful jumps leave the cursor in tmux copy mode. Existing `v` and `y`
bindings select and copy. Both commands also work from existing copy mode,
including a scrolled viewport and an active selection. Bare copy-mode `e`
retains its next-word-end motion. Cancellation preserves existing copy-mode
state or returns to normal mode when invoked there. If another client changes
the shared copy cursor, selection, or viewport while hints are open, Hop discards
the jump and preserves that changed state. Failed cursor moves are rolled back.

Only the current pane's visible viewport is searched. Lines that wrap are
searched as separate screen rows. Resizing, closing the popup, or detaching
the client cancels. The pane must fit fully within the invoking client.
Ordinary CJK and combining characters use terminal-cell coordinates; complex
emoji sequences and custom tmux character-width overrides can differ.

## Installation and tests

Normal dotfiles reconciliation deploys these files. To activate updated
bindings without re-running the main config's session startup commands, use
`tmux source-file ~/.config/tmux/hop/hop.conf` after deploying the files.

Run `python3 -m unittest discover -s tests/tmux` from the repository root.
The integration tests create isolated tmux servers and pseudo-terminal clients;
they do not modify the live server. No TPM or Python packages are required.

Captured text and the selected coordinate live in a private temporary directory
and are removed after the popup closes. Per-client and per-pane advisory locks
prevent concurrent invocations from replacing a popup or moving the same copy
cursor. Small empty lock files remain in the user's temporary directory; they
contain no captured text.