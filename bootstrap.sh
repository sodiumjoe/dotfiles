#!/usr/bin/env bash

mkdir -p ${XDG_CONFIG_HOME:=$HOME/.config}

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

mkdir -p ~/.claude/skills
for skill in ~/.dotfiles/claude/skills/*/; do
  ln -sfn "$skill" ~/.claude/skills/$(basename "$skill")
done

# symlink scripts into ~/bin
mkdir -p ~/bin
for script in ~/.dotfiles/bin/*; do
  ln -sf "$script" ~/bin/$(basename "$script")
done

mkdir -p ${XDG_CONFIG_HOME}/nvim
if [ -L ${XDG_CONFIG_HOME}/nvim/init.lua ]; then
  echo "init.lua symlink already exists, skipping"
else
  ln -s ~/.dotfiles/init.lua ${XDG_CONFIG_HOME}/nvim/init.lua
fi
