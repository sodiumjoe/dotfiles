local dotfiles = vim.env.DOTFILES_TEST_ROOT or vim.fn.expand("~/.dotfiles")
local config = dotfiles .. "/home/.config/nvim"
vim.o.shadafile = "NONE"
local lazypath = vim.fn.stdpath("data") .. "/lazy"
for _, plugin in ipairs(vim.fn.globpath(lazypath, "*", false, true)) do
    vim.opt.rtp:prepend(plugin)
end
vim.opt.rtp:prepend(config)
dofile(config .. "/init.lua")
