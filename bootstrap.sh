#!/usr/bin/env bash

mkdir -p ${XDG_CONFIG_HOME:=$HOME/.config}

# symlink dotfiles

files=(\
  "bin"\
  "curlrc"\
  "cvimrc"\
  "gitconfig"\
  "hammerspoon"\
  "ignore"\
  "inputrc"\
  "zshenv"\
  )

for file in ${files[@]}; do
  dest=${HOME}/.${file}
  if [ -L ${dest} ]; then
    echo "${dest} symlink already exists, skipping"
  elif [ -f ${dest} ]; then
    echo "${dest} is a file, skipping"
  else
    ln -s ~/.dotfiles/${file} ${dest}
  fi
done

xdg_files=(\
  "alacritty"\
  "karabiner"\
  "rg"\
  "tmux"\
  "vivid"\
  "zsh"\
  )

for file in ${xdg_files[@]}; do
  dest=${XDG_CONFIG_HOME}/${file}
  if [ -L ${dest} ]; then
    echo "${dest} symlink already exists, skipping"
    continue
  elif [ -f ${dest} ]; then
    echo "${dest} is a file, skipping"
  elif [ -d ${dest} ]; then
    echo "${dest} is a dir, skipping"
  else
    ln -s ~/.dotfiles/${file} $dest
  fi
done

ln -s ~/.dotfiles/tmux/tmux.conf ~/.tmux.conf

ZIM_HOME=${XDG_CONFIG_HOME}/zsh/.zim

if [ -d $ZIM_HOME ]; then
  pushd $ZIM_HOME
  git pull
  popd
else
  git clone --recursive https://github.com/zimfw/zimfw.git ${ZIM_HOME}
fi

if [ -f ${ZIM_HOME}/zimfw.sh ]; then
  echo "zimfw.sh already exists, skipping"
else
  zsh -c 'ZIM_HOME=${ZIM_HOME} curl -fsSL --create-dirs -o ${ZIM_HOME}/zimfw.zsh https://github.com/zimfw/zimfw/releases/latest/download/zimfw.zsh; source ${ZIM_HOME}/zimfw.zsh init -q'
fi

mkdir -p ${XDG_CONFIG_HOME}/nvim
if [ -L ${XDG_CONFIG_HOME}/nvim/init.lua ]; then
  echo "init.lua symlink already exists, skipping"
else
  ln -s ~/.dotfiles/init.lua ${XDG_CONFIG_HOME}/nvim/init.lua
fi

# install plugins
nvim --headless "+Lazy! restore" +qa
