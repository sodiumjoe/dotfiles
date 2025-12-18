#!/usr/bin/env bash

mkdir -p ${XDG_CONFIG_HOME:=$HOME/.config}

# symlink dotfiles

files=(\
  "bin"\
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
  "CLAUDE.md"\
  "alacritty"\
  "ghostty"\
  "hammerspoon"\
  "karabiner"\
  "rg"\
  "tmux"\
  "vivid"\
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

mkdir -p ${XDG_CONFIG_HOME}/nvim
if [ -L ${XDG_CONFIG_HOME}/nvim/init.lua ]; then
  echo "init.lua symlink already exists, skipping"
else
  ln -s ~/.dotfiles/init.lua ${XDG_CONFIG_HOME}/nvim/init.lua
fi
