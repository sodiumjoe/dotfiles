return {
    {
        "epwalsh/obsidian.nvim",
        version = "*",
        lazy = true,
        ft = "markdown",
        keys = {
            { "<leader>ww", "<cmd>ObsidianToday<cr>" },
        },
        dependencies = {
            "nvim-lua/plenary.nvim",
        },
        opts = {
            workspaces = {
                {
                    name = "work",
                    path = "~/stripe/work",
                },
            },
            completion = {
                nvim_cmp = false,
                min_chars = 2,
            },
            mappings = {
                ["gf"] = {
                    action = function()
                        return require("obsidian").util.gf_passthrough()
                    end,
                    opts = { noremap = false, expr = true, buffer = true },
                },
                ["<C-Space>"] = {
                    action = function()
                        return require("obsidian").util.toggle_checkbox({ " ", "/", "x" })
                    end,
                    opts = { buffer = true },
                },
            },
            ui = {
                enable = false,
            },
        },
    },
}