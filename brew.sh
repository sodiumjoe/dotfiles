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

brew install bat
brew install curl
brew install editorconfig
brew install exa
brew install exiftool
brew install fd
brew install fzf
# set fzf keybindings
${HOMEBREW_PREFIX}/opt/fzf/install
brew install git
brew install gnu-tar
brew install gnupg
brew install htop
# brew install leiningen
brew install lua
brew install luajit
brew install neovim
brew install postgresql
brew install python
brew install python3
brew install ripgrep
brew install spark
brew install sqlite
brew install stylua
brew install tarsnap
brew install tmux
brew install tree
brew install vivid
brew install watchman
brew install yarn
brew install zsh

brew install --cask alfred
brew install --cask bartender
brew install --cask hammerspoon

# python 3 for neovim for deoplete
pip3 install neovim
