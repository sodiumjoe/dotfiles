#!/usr/bin/env bash

mkdir -p ${XDG_CONFIG_HOME:=$HOME/.config}

# --- Environment detection ---

if [ -n "${DOTFILES_ENV:-}" ]; then
  # Accept from environment (for non-interactive use, e.g. devbox init)
  echo "DOTFILES_ENV=$DOTFILES_ENV" > ~/.dotfiles-env
  echo "Using DOTFILES_ENV=$DOTFILES_ENV from environment (wrote ~/.dotfiles-env)"
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
    *) echo "Invalid choice"; exit 1 ;;
  esac
  echo "DOTFILES_ENV=$DOTFILES_ENV" > ~/.dotfiles-env
  echo "Wrote ~/.dotfiles-env (DOTFILES_ENV=$DOTFILES_ENV)"
fi

export DOTFILES_ENV

# --- Generate configs ---

bin/dotfiles-generate

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

ln -s ~/.dotfiles/tmux/tmux.conf ~/.tmux.conf

ln -sf ~/.dotfiles/claude/CLAUDE.md ~/.claude/CLAUDE.md
ln -sf ~/.dotfiles/claude/settings.json ~/.claude/settings.json

mkdir -p ~/.claude/hooks
for hook in ~/.dotfiles/claude/hooks/*; do
  ln -sf "$hook" ~/.claude/hooks/$(basename "$hook")
done

mkdir -p ~/.claude/skills
for skill in ~/.dotfiles/skills/*/; do
  name=$(basename "$skill")
  ln -sfn "$skill" ~/.claude/skills/$name
done

mkdir -p ~/.claude/agents ~/.claude/commands
for agent in ~/.dotfiles/claude/agents/*; do
  ln -sf "$agent" ~/.claude/agents/$(basename "$agent")
done
for cmd in ~/.dotfiles/claude/commands/*; do
  ln -sf "$cmd" ~/.claude/commands/$(basename "$cmd")
done

# --- Work + devbox symlinks (Codex, work-cli) ---

if [ "$DOTFILES_ENV" = "work" ] || [ "$DOTFILES_ENV" = "devbox" ]; then
  mkdir -p ~/.codex ~/.codex/skills
  ln -sf ~/.dotfiles/codex/config.toml ~/.codex/config.toml
  ln -sf ~/.dotfiles/codex/AGENTS.md ~/.codex/AGENTS.md

  for skill in ~/.dotfiles/skills/*/; do
    name=$(basename "$skill")
    ln -sfn "$skill" ~/.codex/skills/$name
  done

  mkdir -p ~/bin
  ln -sf ~/.dotfiles/work-cli/bin/work ~/bin/work
fi

# --- Universal bin symlinks ---

mkdir -p ~/bin
for script in ~/.dotfiles/bin/*; do
  ln -sf "$script" ~/bin/$(basename "$script")
done

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
