return {
    {
        "nvim-treesitter/nvim-treesitter",
        branch = "main",
        build = ":TSUpdate",
        lazy = false,
        keys = {
            {
                [[<leader>h]],
                function()
                    local ts_result = vim.treesitter.get_captures_at_cursor(0)
                    local lsp_result = vim.lsp.semantic_tokens.get_at_pos()
                    print(vim.inspect({ ts = ts_result, lsp = lsp_result }))
                end,
                desc = "Inspect treesitter and LSP highlights",
            },
        },
    },
    "nvim-treesitter/nvim-treesitter-context",
}
