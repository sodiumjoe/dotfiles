return {
    {
        "saghen/blink.cmp",
        lazy = false,
        version = "v1.*",
        opts = {
            keymap = {
                preset = "default",
                ["<CR>"] = { "accept", "fallback" },
            },
            completion = {
                menu = {
                    auto_show = function(ctx)
                        return ctx.mode ~= "cmdline"
                    end,
                },
                list = {
                    selection = { preselect = false, auto_insert = true },
                },
            },
        },
        config = function(_, opts)
            require("blink.cmp").setup(opts)
            vim.lsp.config("*", {
                capabilities = require("blink.cmp").get_lsp_capabilities(vim.lsp.protocol.make_client_capabilities()),
            })
        end,
    },
    {
        "rafamadriz/friendly-snippets",
        lazy = true,
    },
}
