#!/usr/bin/env bash

# Ask for the administrator password upfront.
sudo -v

# Keep-alive: update existing `sudo` time stamp until the script has finished.
while true; do sudo -n true; sleep 60; kill -0 "$$" || exit; done 2>/dev/null &

# http://brew.sh/
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

brew update
brew upgrade

# https://caskroom.github.io/
brew tap homebrew/cask

# https://github.com/Homebrew/homebrew-cask-versions
brew tap homebrew/cask-versions

# https://github.com/Homebrew/homebrew-cask-fonts
brew tap homebrew/cask-fonts

brew install bat
brew install curl
brew install editorconfig
brew install exa
brew install exiftool
brew install fd
brew install fzf
# set fzf keybindings
/opt/homebrew/opt/fzf/install
brew install git
brew install gnu-tar
brew install gnupg
brew install htop
# brew install leiningen
brew install lua
brew install luajit
brew install neovim/neovim/neovim
brew install postgresql
brew install python
brew install python3
brew install ranger
brew install ripgrep
brew install rq
brew install spark
brew install sqlite
brew install tarsnap
brew install tmux
brew install tree
brew install vivid
brew install watchman
brew install yarn
brew install zsh

brew install --cask alfred
brew install --cask bartender
brew install --cask dropbox
brew install --cask hammerspoon
brew install --cask vlc
brew install --cask font-inconsolata-go-nerd-font

# neovim
ln -s ~/.dotfiles/init.lua ${XDG_CONFIG_HOME}/nvim/init.lua

# python 3 for neovim for deoplete
pip3 install neovim

# update deoplete
nvim +UpdateRemotePlugins +qall

# vim-plug
curl -fLo ~/.config/nvim/autoload/plug.vim --create-dirs \
      https://raw.githubusercontent.com/junegunn/vim-plug/master/plug.vim
