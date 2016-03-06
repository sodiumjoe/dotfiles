#!/usr/bin/env bash

# Ask for the administrator password upfront.
sudo -v

# Keep-alive: update existing `sudo` time stamp until the script has finished.
while true; do sudo -n true; sleep 60; kill -0 "$$" || exit; done 2>/dev/null &

git clone --recursive https://github.com/sodiumjoe/prezto.git ~/.zprezto

git clone https://github.com/sodiumjoe/nvm.git ~/.nvm

symlink dotfiles

files=("mackup.cfg" "agignore" "gitconfig" "tmux.conf" "vimrc")

for file in ${files[@]}; do
  ln -s ~/.dotfiles/${file} ~/.${file}
done

# http://brew.sh/
/usr/bin/ruby -e "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/master/install)"
