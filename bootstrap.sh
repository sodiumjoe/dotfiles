#!/usr/bin/env bash

git clone --recursive https://github.com/sodiumjoe/prezto.git ~/.zprezto

git clone https://github.com/sodiumjoe/nvm.git ~/.nvm

symlink dotfiles

files=("agignore" "gitconfig" "tmux.conf" "vimrc")

for file in ${files[@]}; do
  ln -s ~/.dotfiles/${file} ~/.${file}
done

# http://brew.sh/
/usr/bin/ruby -e "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/master/install)"
