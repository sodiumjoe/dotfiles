#!/usr/bin/env bash

# Ask for the administrator password upfront.
sudo -v

# Keep-alive: update existing `sudo` time stamp until the script has finished.
while true; do sudo -n true; sleep 60; kill -0 "$$" || exit; done 2>/dev/null &

export XDG_CONFIG_HOME = ${XDG_CONFIG_HOME:=$HOME/.config}
mkdir -p ${XDG_CONFIG_HOME}

local ZIM_DIR=${XDG_CONFIG_HOME}/zsh/.zim

if [ -d $ZIM_DIR ]
then
  pushd $ZIM_DIR
  git pull
  popd
else
  git clone --recursive git@github.com:zimfw/zimfw.git ${XDG_CONFIG_HOME}/zsh/.zim
fi

# symlink dotfiles

files=(\
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
  local dest=${XDG_CONFIG_HOME}/.${file}
  if [ -L $dest ]
  then
    echo "${dest} symlink already exists, skipping"
    continue
  elif [ -f $dest] ]
    echo "${dest} is a file, skipping"
  else
    ln -s ~/.dotfiles/${file} $dest
  fi
done

xdg_files=(\
  "alacritty"\
  "hammerspoon"\
  "rg"\
  "zsh"\
  "tmux"\
  "karabiner"\
  "vivid"\
  )

for file in ${xdg_files[@]}; do
  local dest=${XDG_CONFIG_HOME}/${file}
  if [ -L $dest ]
  then
    echo "${dest} symlink already exists, skipping"
    continue
  elif [ -f $dest] ]
    echo "${dest} is a file, skipping"
  elif [ -d $dest] ]
    echo "${dest} is a dir, skipping"
  else
    ln -s ~/.dotfiles/${file} $dest
  fi
done

# http://brew.sh/
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
