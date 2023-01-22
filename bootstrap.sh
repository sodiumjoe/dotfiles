#!/usr/bin/env bash

mkdir -p ${XDG_CONFIG_HOME:=$HOME/.config}

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
  if [ -L ${dest} ]; then
    echo "${dest} symlink already exists, skipping"
    continue
  elif [ -f ${dest} ]
    echo "${dest} is a file, skipping"
  else
    ln -s ~/.dotfiles/${file} ${dest}
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
  if [ -L ${dest} ]; then
    echo "${dest} symlink already exists, skipping"
    continue
  elif [ -f ${dest} ]
    echo "${dest} is a file, skipping"
  elif [ -d ${dest} ]
    echo "${dest} is a dir, skipping"
  else
    ln -s ~/.dotfiles/${file} $dest
  fi
done

local ZIM_DIR=${XDG_CONFIG_HOME}/zsh/.zim

if [ -d $ZIM_DIR ]; then
  pushd $ZIM_DIR
  git pull
  popd
else
  git clone --recursive git@github.com:zimfw/zimfw.git ${ZIM_DIR}
  zsh -c 'curl -fsSL --create-dirs -o ${ZIM_HOME}/zimfw.zsh https://github.com/zimfw/zimfw/releases/latest/download/zimfw.zsh; source ${ZIM_HOME}/zimfw.zsh init -q'
fi

mkdir -p ${XDG_CONFIG_HOME}/nvim
ln -s ~/.dotfiles/init.lua ${XDG_CONFIG_HOME}/nvim/init.lua

# install packer
if [ -d ~/.local/share/nvim/site/pack/packer/start/packer.nvim ]; then
  echo "Packer already installed"
else
  git clone --depth 1 https://github.com/wbthomason/packer.nvim\
    ~/.local/share/nvim/site/pack/packer/start/packer.nvim
fi

# install plugins
nvim --headless -c 'autocmd User PackerCompileDone quitall' -c 'PackerSync'
nvim --headless -c 'autocmd User PackerComplete quitall' -c 'PackerSnapshotRollback packer-snapshot.json'
nvim --headless -c 'autocmd User PackerCompileDone quitall' -c 'PackerCompile'
