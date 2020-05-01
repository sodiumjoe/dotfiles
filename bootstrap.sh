#!/usr/bin/env bash

# Ask for the administrator password upfront.
sudo -v

# Keep-alive: update existing `sudo` time stamp until the script has finished.
while true; do sudo -n true; sleep 60; kill -0 "$$" || exit; done 2>/dev/null &

git clone --recursive https://github.com/sodiumjoe/zim.git ${ZDOTDIR:-${HOME}}/.zim

# symlink dotfiles

files=(\
  "mackup.cfg"\
  "ignore"\
  "gitconfig"\
  "tmux.conf"\
  "cvimrc"\
  "bin"\
  "curlrc"\
  "inputrc"\
  "zshenv"\
  )

for file in ${files[@]}; do
  ln -s ~/.dotfiles/${file} ~/.${file}
done

xdg_files=(\
  "alacritty"\
  "hammerspoon"\
  "rg"\
  "zsh"\
  )

mkdir -p ${XDG_CONFIG_HOME:=$HOME/.config}

for file in ${xdg_files[@]}; do
  ln -s ~/.dotfiles/${file} ${XDG_CONFIG_HOME}/${file}
done

# http://brew.sh/
/usr/bin/ruby -e \
  "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/master/install)"
