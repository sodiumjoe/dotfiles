local dotfiles = vim.env.DOTFILES_TEST_ROOT or vim.fn.expand("~/.dotfiles")
local config = dotfiles .. "/home/.config/nvim"
vim.o.shadafile = "NONE"
local lazypath = vim.fn.stdpath("data") .. "/lazy"
for _, plugin in ipairs(vim.fn.globpath(lazypath, "*", false, true)) do
    vim.opt.rtp:prepend(plugin)
end
vim.opt.rtp:prepend(config)
local ok, err = xpcall(function()
    local lazy = require("lazy")
    local setup = lazy.setup
    lazy.setup = function(spec, opts)
        opts.install.missing = false
        opts.checker = { enabled = false }
        setup(spec, opts)
        local missing = {}
        for name, plugin in pairs(require("lazy.core.config").plugins) do
            if vim.fn.isdirectory(plugin.dir) == 0 then
                missing[#missing + 1] = name
            end
        end
        if #missing > 0 then
            table.sort(missing)
            error("Missing Neovim plugins: " .. table.concat(missing, ", ") .. ". Run :Lazy sync first.")
        end
    end
    dofile(config .. "/init.lua")
end, debug.traceback)
if not ok then
    vim.api.nvim_err_writeln(err)
    vim.cmd("cquit 1")
end