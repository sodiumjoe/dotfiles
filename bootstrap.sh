#!/usr/bin/env bash

mkdir -p ${XDG_CONFIG_HOME:=$HOME/.config}

generate_instructions() {
  echo "Generating CLAUDE.md..."
  cat shared/base-instructions.md shared/work-tracking.md shared/neovim.md claude-overlay.md > claude/CLAUDE.md
  echo "Generating AGENTS.md..."
  mkdir -p codex
  cat shared/base-instructions.md shared/work-tracking.md shared/neovim.md codex-overlay.md > codex/AGENTS.md
}

generate_instructions

# symlink dotfiles

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

mkdir -p ~/.claude/skills ~/.codex/skills
for skill in ~/.dotfiles/skills/*/; do
  name=$(basename "$skill")
  ln -sfn "$skill" ~/.claude/skills/$name
  ln -sfn "$skill" ~/.codex/skills/$name
done

mkdir -p ~/.claude/agents ~/.claude/commands
for agent in ~/.dotfiles/claude/agents/*; do
  ln -sf "$agent" ~/.claude/agents/$(basename "$agent")
done
for cmd in ~/.dotfiles/claude/commands/*; do
  ln -sf "$cmd" ~/.claude/commands/$(basename "$cmd")
done

mkdir -p ~/.codex
ln -sf ~/.dotfiles/codex/config.toml ~/.codex/config.toml
ln -sf ~/.dotfiles/codex/AGENTS.md ~/.codex/AGENTS.md

# symlink scripts into ~/bin
mkdir -p ~/bin
for script in ~/.dotfiles/bin/*; do
  ln -sf "$script" ~/bin/$(basename "$script")
done
ln -sf ~/.dotfiles/work-cli/bin/work ~/bin/work

mkdir -p ${XDG_CONFIG_HOME}/nvim
if [ -L ${XDG_CONFIG_HOME}/nvim/init.lua ]; then
  echo "init.lua symlink already exists, skipping"
else
  ln -s ~/.dotfiles/init.lua ${XDG_CONFIG_HOME}/nvim/init.lua
fi
