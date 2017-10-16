#!/usr/bin/env bash

# Ask for the administrator password upfront.
sudo -v

# Keep-alive: update existing `sudo` time stamp until the script has finished.
while true; do sudo -n true; sleep 60; kill -0 "$$" || exit; done 2>/dev/null &

git clone --recursive https://github.com/sodiumjoe/zim.git ${ZDOTDIR:-${HOME}}/.zim

git clone https://github.com/sodiumjoe/nvm.git ~/.nvm

mkdir ~/play

git clone git@github.com:changyuheng/fz.git ~/play/fz
git clone git@github.com:rupa/z.git ~/play/z
git clone git@github.com:jimhester/per-directory-history.git \
  ~/play/per-directory-history
git clone https://github.com/lukechilds/zsh-better-npm-completion.git \
  ~/play/zsh-better-npm-completion
git clone https://github.com/lukechilds/zsh-nvm.git ~/play/zsh-nvm

# symlink dotfiles

files=(\
  "mackup.cfg"\
  "ignore"\
  "gitconfig"\
  "tmux.conf"\
  "vimrc"\
  "cvimrc"\
  "zlogin"\
  "zshrc"\
  "zimrc"\
  "alacritty.yml"\
  )

for file in ${files[@]}; do
  ln -s ~/.dotfiles/${file} ~/.${file}
done

# http://brew.sh/
/usr/bin/ruby -e \
  "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/master/install)"
