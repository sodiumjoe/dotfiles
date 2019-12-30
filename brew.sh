#!/usr/bin/env bash

# Ask for the administrator password upfront.
sudo -v

# Keep-alive: update existing `sudo` time stamp until the script has finished.
while true; do sudo -n true; sleep 60; kill -0 "$$" || exit; done 2>/dev/null &

brew update
brew upgrade --all

# https://caskroom.github.io/
brew tap caskroom/cask

# https://github.com/caskroom/homebrew-versions
brew tap caskroom/versions

# https://github.com/caskroom/homebrew-fonts
brew tap caskroom/fonts

brew install curl
brew install editorconfig
brew install exa
brew install fd
brew install fzf
# set fzf keybindings
/usr/local/opt/fzf/install
brew install git
brew install gnu-tar
brew install gnupg
brew install htop
brew install karn
# brew install leiningen
brew install lua
brew install luajit
brew install mackup
brew install neovim/neovim/neovim
brew install postgresql
brew install python
brew install python3
brew install ranger
brew install ripgrep
brew install rq
brew install spark
brew install sqlite
brew install tmux
brew install tree
brew install watchman
brew install yarn
brew install zsh

brew cask install alfred
brew cask install bartender
brew cask install bettertouchtool
brew cask install crashplan
brew cask install dropbox
brew cask install hammerspoon
brew cask install vlc
brew cask install google-chrome-beta
brew cask install font-inconsolata-nerd-font

# neovim
ln -s ~/.dotfiles/init.vim $XDG_CONFIG_HOME/nvim/init.vim


# python 3 for neovim for deoplete
pip3 install neovim

# update deoplete
nvim +UpdateRemotePlugins +qall

# vim-plug
curl -fLo ~/.config/nvim/autoload/plug.vim --create-dirs \
      https://raw.githubusercontent.com/junegunn/vim-plug/master/plug.vim
