local g = vim.g
local o = vim.o

o.runtimepath = vim.o.runtimepath .. [[,~/.dotfiles/neovim]]
o.termguicolors = true

g.mapleader = [[ ]]
-- faster startup time
-- :h g:python_host_prog
g.python_host_prog = "/usr/bin/python"
-- :h g:python3_host_prog
g.python3_host_prog = "$HOMEBREW_PREFIX/bin/python3"

require("sodium.plugins")
require("sodium.general")
