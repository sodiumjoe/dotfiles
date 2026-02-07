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
    },
    {
        "rafamadriz/friendly-snippets",
        lazy = true,
    },
}
