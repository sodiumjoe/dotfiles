#!/usr/bin/env bash

# Ask for the administrator password upfront.
sudo -v

# Keep-alive: update existing `sudo` time stamp until the script has finished.
while true; do sudo -n true; sleep 60; kill -0 "$$" || exit; done 2>/dev/null &

git clone --recursive https://github.com/sodiumjoe/prezto.git ~/.zprezto

git clone https://github.com/sodiumjoe/nvm.git ~/.nvm

# symlink dotfiles

files=("mackup.cfg" "agignore" "gitconfig" "tmux.conf" "vimrc")

for file in ${files[@]}; do
  ln -s ~/.dotfiles/${file} ~/.${file}
done

# neovim
mkdir -p ${XDG_CONFIG_HOME:=$HOME/.config}
ln -s ~/.vim $XDG_CONFIG_HOME/nvim
ln -s ~/.vimrc $XDG_CONFIG_HOME/nvim/init.vim

# python 3 for neovim for deoplete
pip3 install neovim

# update deoplete
nvim +UpdateRemotePlugins +qall

# vim-plug
curl -fLo ~/.config/nvim/autoload/plug.vim --create-dirs \
      https://raw.githubusercontent.com/junegunn/vim-plug/master/plug.vim

# http://brew.sh/
/usr/bin/ruby -e "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/master/install)"
