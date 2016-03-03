#!/usr/bin/env bash

brew update
brew upgrade --all

# https://caskroom.github.io/
brew tap caskroom/cask

# https://github.com/caskroom/homebrew-versions
brew tap caskroom/versions

# https://github.com/caskroom/homebrew-fonts
brew tap caskroom/fonts

brew install autojump
brew install curl
brew install fzf
brew install git
brew install gnu-tar
brew install gnupg
brew install httpie
brew install jq
brew install leiningen
brew install lua
brew install luajit
brew install mackup
brew install neovim
brew install postgresql
brew install python
brew install python3
brew install rust
brew install sqlite
brew install the_silver_searcher
brew install tmux
brew install tree
brew install zsh

brew cask install alfred
brew cask install bartender
brew cask install bettertouchtool
brew cask install clipmenu
brew cask install controlplane
brew cask install crashplan
brew cask install dropbox
brew cask install flux
brew cask install hammerspoon
brew cask install iterm2
brew cask install karabiner
brew cask install vlc
brew cask install google-chrome-beta
brew cask install font-inconsolata-g-for-powerline
