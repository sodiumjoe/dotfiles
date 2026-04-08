return {
    {
        -- standalone sodium colorscheme — no external plugin needed
        -- using a dummy dir entry so lazy.nvim has something to load
        dir = vim.fn.stdpath("config"),
        name = "sodium-colorscheme",
        priority = 1000,
        config = function()
            local utils = require("sodium.utils")
            local colorscheme = require("sodium.config.colorscheme")

            colorscheme.apply()

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
