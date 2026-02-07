return {
    {
        "sodiumjoe/sodium.nvim",
        enabled = false,
        config = function()
            local utils = require("sodium.utils")
            require("sodium")
            vim.cmd.colorscheme("sodium-dark")
            local line_nr_autocmd = utils.augroup("LineNr", { clear = true })
            line_nr_autocmd("FileType", {
                pattern = { "dirvish", "help" },
                callback = function()
                    vim.opt_local.number = false
                end,
            })
            line_nr_autocmd({ "BufNewFile", "BufRead", "BufEnter" }, {
                pattern = "*",
                callback = function()
                    if vim.filetype.match({ buf = 0 }) == nil then
                        vim.opt_local.number = false
                    else
                        vim.opt_local.number = true
                    end
                end,
            })
            local cursorline_autocomd = utils.augroup("CurrentBufferCursorline", { clear = true })
            cursorline_autocomd({ "VimEnter", "WinEnter", "BufWinEnter" }, {
                pattern = "*",
                callback = function()
                    vim.opt_local.cursorline = true
                end,
            })
            cursorline_autocomd({ "WinLeave" }, {
                pattern = "*",
                callback = function()
                    vim.opt_local.cursorline = false
                end,
            })
        end,
    },
    {
        "rktjmp/lush.nvim",
        lazy = true,
    },
    {
        "rktjmp/shipwright.nvim",
        cmd = { "Shipwright" },
        lazy = true,
    },
    {
        "EdenEast/nightfox.nvim",
        -- enabled = false,
        config = function()
            local utils = require("sodium.utils")

            require("nightfox").setup({
                options = {
                    transparent = false,
                    dim_inactive = false,
                },
                palettes = {
                    all = require("sodium.config.colorscheme").palette,
                },
                specs = {
                    all = require("sodium.config.colorscheme").spec,
                },
                groups = {
                    all = require("sodium.config.colorscheme").groups,
                },
            })

            vim.cmd.colorscheme("nightfox")

            local line_nr_autocmd = utils.augroup("LineNr", { clear = true })
            line_nr_autocmd("FileType", {
                pattern = { "dirvish", "help" },
                callback = function()
                    vim.opt_local.number = false
                end,
            })
            line_nr_autocmd({ "BufNewFile", "BufRead", "BufEnter" }, {
                pattern = "*",
                callback = function()
                    if vim.filetype.match({ buf = 0 }) == nil then
                        vim.opt_local.number = false
                    else
                        vim.opt_local.number = true
                    end
                end,
            })

            local cursorline_autocomd = utils.augroup("CurrentBufferCursorline", { clear = true })
            cursorline_autocomd({ "VimEnter", "WinEnter", "BufWinEnter" }, {
                pattern = "*",
                callback = function()
                    vim.opt_local.cursorline = true
                end,
            })
            cursorline_autocomd({ "WinLeave" }, {
                pattern = "*",
                callback = function()
                    vim.opt_local.cursorline = false
                end,
            })
        end,
    },
}
