local lazypath = vim.fn.stdpath("data") .. "/lazy"
for _, plugin in ipairs(vim.fn.globpath(lazypath, "*", false, true)) do
    vim.opt.rtp:prepend(plugin)
end
dofile(vim.fn.expand("~/.dotfiles/init.lua"))