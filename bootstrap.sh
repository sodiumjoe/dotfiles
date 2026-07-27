#!/usr/bin/env bash
set -euo pipefail

shopt -s nullglob

mkdir -p ${XDG_CONFIG_HOME:=$HOME/.config}

# --- Environment detection ---
#
# Precedence: --env flag, then ~/.dotfiles-env, then interactive prompt.
#
# The ambient $DOTFILES_ENV is deliberately NOT consulted: zshenv exports it
# unconditionally (defaulting to home), so trusting it would make the prompt
# unreachable and would silently re-commit a stale value whenever ~/.dotfiles-env
# is deleted in order to re-select. Non-interactive callers pass --env.

selected_env=""

while [ $# -gt 0 ]; do
  case "$1" in
    --env) selected_env="${2:-}"; shift 2 ;;
    --env=*) selected_env="${1#--env=}"; shift ;;
    *) echo "bootstrap.sh: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

if [ -n "$selected_env" ]; then
  DOTFILES_ENV="$selected_env"
elif [ -f ~/.dotfiles-env ]; then
  . ~/.dotfiles-env
else
  printf "No ~/.dotfiles-env found. Select environment:\n"
  printf "  1) work\n"
  printf "  2) devbox\n"
  printf "  3) home\n"
  printf "Choice: "
  read choice
  case "$choice" in
    1) DOTFILES_ENV=work ;;
    2) DOTFILES_ENV=devbox ;;
    3) DOTFILES_ENV=home ;;
    *) echo "Invalid choice" >&2; exit 1 ;;
  esac
fi

case "$DOTFILES_ENV" in
  work|devbox|home) ;;
  *) echo "bootstrap.sh: invalid environment '$DOTFILES_ENV' (expected work, devbox, or home)" >&2; exit 1 ;;
esac

echo "DOTFILES_ENV=$DOTFILES_ENV" > ~/.dotfiles-env
echo "Using DOTFILES_ENV=$DOTFILES_ENV (wrote ~/.dotfiles-env)"

export DOTFILES_ENV

# --- Generate configs ---

bin/dotfiles-generate

# --- Symlink helper ---
#
# ~/.claude may itself be a symlink into this repo, in which case source and
# destination resolve to the same file and `ln -sf` would silently replace it
# with a self-referential symlink (ELOOP), destroying the contents.

link() {
  local src="$1" dest="$2"
  if [ "$(readlink -f "$src" 2>/dev/null)" = "$(readlink -f "$dest" 2>/dev/null)" ]; then
    return 0
  fi
  ln -sfn "$src" "$dest"
}

# --- Symlink dotfiles ---

files=(\
  "curlrc"\
  "cvimrc"\
  "gitconfig"\
  "ignore"\
  "inputrc"\
  "zshenv"\
  )

for file in ${files[@]}; do
  dest=${HOME}/.${file}
  if [ -L ${dest} ]; then
    echo "${dest} symlink already exists, skipping"
  elif [ -f ${dest} ]; then
    echo "${dest} is a file, skipping"
  else
    ln -s ~/.dotfiles/${file} ${dest}
  fi
done

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

for file in ${xdg_files[@]}; do
  dest=${XDG_CONFIG_HOME}/${file}
  if [ -L ${dest} ]; then
    echo "${dest} symlink already exists, skipping"
    continue
  elif [ -f ${dest} ]; then
    echo "${dest} is a file, skipping"
  elif [ -d ${dest} ]; then
    echo "${dest} is a dir, skipping"
  else
    ln -s ~/.dotfiles/${file} $dest
  fi
done

if [ ! -L ~/.tmux.conf ]; then
  ln -s ~/.dotfiles/tmux/tmux.conf ~/.tmux.conf
fi

mkdir -p ~/.claude
link ~/.dotfiles/claude/CLAUDE.md ~/.claude/CLAUDE.md
link ~/.dotfiles/claude/settings.json ~/.claude/settings.json

mkdir -p ~/.claude/hooks
for hook in ~/.dotfiles/claude/hooks/*; do
  link "$hook" ~/.claude/hooks/$(basename "$hook")
done

mkdir -p ~/.claude/skills
for skill in ~/.dotfiles/skills/*/; do
  link "$skill" ~/.claude/skills/$(basename "$skill")
done

mkdir -p ~/.claude/agents ~/.claude/commands
for agent in ~/.dotfiles/claude/agents/*; do
  link "$agent" ~/.claude/agents/$(basename "$agent")
done
for cmd in ~/.dotfiles/claude/commands/*; do
  link "$cmd" ~/.claude/commands/$(basename "$cmd")
done

# --- Work + devbox symlinks (Codex, work-cli) ---

if [ "$DOTFILES_ENV" = "work" ] || [ "$DOTFILES_ENV" = "devbox" ]; then
  mkdir -p ~/.codex ~/.codex/skills
  link ~/.dotfiles/codex/config.toml ~/.codex/config.toml
  link ~/.dotfiles/codex/AGENTS.md ~/.codex/AGENTS.md

  for skill in ~/.dotfiles/skills/*/; do
    link "$skill" ~/.codex/skills/$(basename "$skill")
  done

  mkdir -p ~/bin
  link ~/.dotfiles/work-cli/bin/work ~/bin/work
fi

# --- Universal bin symlinks ---

mkdir -p ~/bin
for script in ~/.dotfiles/bin/*; do
  link "$script" ~/bin/$(basename "$script")
done

# --- Pinned npm tool binaries (ACP providers, language servers, formatters) ---

if command -v npm &>/dev/null; then
  echo "Installing node-bin packages..."
  if [ -f node-bin/package-lock.json ]; then
    npm ci --prefix node-bin
  else
    npm install --prefix node-bin
  fi
else
  echo "npm not found, skipping node-bin (ACP providers will be unavailable)" >&2
fi

# --- Neovim ---

mkdir -p ${XDG_CONFIG_HOME}/nvim
if [ -L ${XDG_CONFIG_HOME}/nvim/init.lua ]; then
  echo "init.lua symlink already exists, skipping"
else
  ln -s ~/.dotfiles/init.lua ${XDG_CONFIG_HOME}/nvim/init.lua
fi

# --- Git hooks ---

if [ -d .git ]; then
  mkdir -p .git/hooks
  ln -sf ../../hooks/post-merge .git/hooks/post-merge
fi
