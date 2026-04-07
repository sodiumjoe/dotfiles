return {
    "onsails/lspkind-nvim",
    lazy = true,
    keys = {
        { "gD", vim.lsp.buf.declaration },
        {
            "K",
            function()
                vim.lsp.buf.hover({ focusable = false })
            end,
        },
        { "gi", vim.lsp.buf.implementation },
        {
            [[<leader>ca]],
            vim.lsp.buf.code_action,
        },
        {
            [[<leader>ee]],
            function()
                local diagnostics = require("sodium.config.diagnostics")
                local new_config = not vim.diagnostic.config().virtual_lines
                vim.diagnostic.config({
                    virtual_lines = new_config and diagnostics.virtual_lines_config or false,
                })
            end,
        },
        {
            [[<leader>p]],
            function()
                vim.diagnostic.jump({
                    count = -1,
                    severity = vim.diagnostic.severity.ERROR,
                })
            end,
        },
        {
            [[<leader>n]],
            function()
                vim.diagnostic.jump({
                    count = 1,
                    severity = vim.diagnostic.severity.ERROR,
                })
            end,
        },
        {
            [[<leader><Space>n]],
            function()
                vim.diagnostic.jump({
                    count = 1,
                    severity = {
                        max = vim.diagnostic.severity.WARN,
                    },
                })
            end,
        },
        {
            [[<leader><Space>p]],
            function()
                vim.diagnostic.jump({
                    count = -1,
                    severity = {
                        max = vim.diagnostic.severity.WARN,
                    },
                })
            end,
        },
        {
            [[<leader>f]],
            function()
                require("sodium.config.lsp.formatting").format(0)
            end,
        },
    },
}
