local g = vim.g
local o = vim.o

o.runtimepath = vim.o.runtimepath .. [[,~/.dotfiles/neovim]]
o.termguicolors = true

g.mapleader = [[ ]]
g.python_host_prog = "/usr/bin/python"
g.python3_host_prog = "$HOMEBREW_PREFIX/bin/python3"

g.loaded_netrw = 1
g.loaded_netrwPlugin = 1

local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not vim.uv.fs_stat(lazypath) then
    local lazyrepo = "https://github.com/folke/lazy.nvim.git"
    local out = vim.fn.system({ "git", "clone", "--filter=blob:none", "--branch=stable", lazyrepo, lazypath })
    if vim.v.shell_error ~= 0 then
        vim.api.nvim_echo({
            { "Failed to clone lazy.nvim:\n", "ErrorMsg" },
            { out, "WarningMsg" },
            { "\nPress any key to exit..." },
        }, true, {})
        vim.fn.getchar()
        os.exit(1)
    end
end
vim.opt.rtp:prepend(lazypath)

require("sodium.config.options")

require("sodium.config.diagnostics")

require("lazy").setup({ import = "sodium.plugins" }, {
    lockfile = "~/.dotfiles/lazy-lock.json",
    dev = {
        path = "~/home",
    },
    install = {
        missing = true,
        colorscheme = { "sodium" },
    },
    performance = {
        rtp = {
            paths = { "~/.dotfiles/neovim" },
        },
    },
})

require("sodium.config.autocmds")
require("sodium.config.keymaps")

local in_stripe_repo = vim.fn.isdirectory("/pay/src") ~= 0 or vim.fn.isdirectory(vim.fn.expand("~/stripe/")) ~= 0

if in_stripe_repo then
    require("sodium.config.stripe")
end
