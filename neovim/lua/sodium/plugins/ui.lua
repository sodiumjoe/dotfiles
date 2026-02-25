return {
    {
        "nvim-lualine/lualine.nvim",
        config = function()
            require("sodium.statusline")
        end,
        lazy = false,
    },
    {
        "luukvbaal/statuscol.nvim",
        config = function()
            local builtin = require("statuscol.builtin")
            require("statuscol").setup({
                segments = {
                    {
                        text = { builtin.lnumfunc },
                        sign = { namespace = { "diagnostic" } },
                    },
                    { text = { " " } },
                    {
                        sign = {
                            name = { "Signify.*" },
                            fillchar = "│",
                            colwidth = 1,
                        },
                    },
                    { text = { " " } },
                },
            })
        end,
    },
    {
        "catgoose/nvim-colorizer.lua",
        event = "BufReadPre",
        opts = {},
    },
    {
        "onsails/lspkind-nvim",
        lazy = true,
    },
    {
        "MeanderingProgrammer/render-markdown.nvim",
        -- dependencies = { "nvim-treesitter/nvim-treesitter", "nvim-mini/mini.nvim" }, -- if you use the mini.nvim suite
        -- dependencies = { 'nvim-treesitter/nvim-treesitter', 'nvim-mini/mini.icons' },        -- if you use standalone mini plugins
        dependencies = { "nvim-treesitter/nvim-treesitter", "nvim-tree/nvim-web-devicons" }, -- if you prefer nvim-web-devicons
        opts = {
            heading = {
                width = "block",
                left_pad = 1,
                right_pad = 2,
                border = true,
                border_virtual = true,
            },
            code = {
                left_margin = 2,
                border = "thin",
                width = "block",
                language_pad = 2,
                left_pad = 2,
                right_pad = 2,
                inline = false,
            },
        },
    },
    {
        "mhinz/vim-signify",
        config = function()
            vim.g.signify_sign_add = "│"
            vim.g.signify_sign_change = "│"
            vim.g.signify_sign_change_delete = "_│"
            vim.g.signify_sign_show_count = 0
            vim.g.signify_skip = { vcs = { allow = { "git" } } }
        end,
    },
    "rhysd/conflict-marker.vim",
}
