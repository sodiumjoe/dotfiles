vim.o.runtimepath = vim.o.runtimepath .. [[,~/.dotfiles/neovim]]
vim.o.termguicolors = true

require("sodium.plugins")
require("sodium.general")
require("sodium.statusline")
