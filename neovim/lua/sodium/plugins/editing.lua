return {
    {
        "smoka7/hop.nvim",
        opts = { create_hl_autocmd = false },
        keys = {
            {
                [[<leader>ew]],
                function()
                    require("hop").hint_words()
                end,
            },
            {
                [[<leader>e/]],
                function()
                    require("hop").hint_patterns()
                end,
            },
        },
        lazy = true,
    },
    {
        "kaplanz/nvim-retrail",
        opts = {
            hlgroup = "Error",
            pattern = "\\v((.*%#)@!|%#)\\s+$",
            filetype = {
                strict = false,
                include = {},
                exclude = {
                    "",
                    "aerial",
                    "alpha",
                    "checkhealth",
                    "diff",
                    "lazy",
                    "lspinfo",
                    "man",
                    "mason",
                    "WhichKey",
                    "markdown",
                    "javascript",
                },
            },
            buftype = {
                strict = false,
                include = {},
                exclude = {
                    "help",
                    "nofile",
                    "prompt",
                    "quickfix",
                    "terminal",
                },
            },
            trim = {
                auto = true,
                whitespace = true,
                blanklines = false,
            },
        },
    },
    {
        "benizi/vim-automkdir",
        event = "BufWritePre",
    },
    {
        "justinmk/vim-dirvish",
        config = function()
            local utils = require("sodium.utils")
            local dirvish_autocmd = utils.augroup("DirvishConfig", { clear = true })
            dirvish_autocmd("FileType", {
                pattern = { "dirvish" },
                command = "silent! unmap <buffer> <C-p>",
            })
            dirvish_autocmd("FileType", {
                pattern = { "dirvish" },
                command = "silent! unmap <buffer> <C-n>",
            })
            dirvish_autocmd("FileType", {
                pattern = "dirvish",
                callback = function()
                    vim.cmd("syntax on")
                end,
            })
        end,
    },
    {
        "tpope/vim-eunuch",
        cmd = {
            "Remove",
            "Delete",
            "Move",
            "Chmod",
            "Mkdir",
            "Cfind",
            "Clocate",
            "Wall",
            "SudoWrite",
            "SudoEdit",
        },
    },
    "tpope/vim-repeat",
    "tpope/vim-surround",
    {
        "echasnovski/mini.move",
        dependencies = { "echasnovski/mini.nvim" },
        version = "*",
        opts = {
            mappings = {
                left = "",
                right = "",
                down = "<C-j>",
                up = "<C-k>",
                line_left = "",
                line_right = "",
                line_down = "<C-j>",
                line_up = "<C-k>",
            },
        },
        keys = { "<C-j>", "<C-k>", "v", "V", "<C-v>" },
        lazy = true,
    },
    {
        "haya14busa/is.vim",
        keys = {
            "/",
            "n",
            "N",
            "*",
            "#",
            "g*",
            "g#",
        },
    },
}
