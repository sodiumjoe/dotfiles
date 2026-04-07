return {
    {
        "nvim-treesitter/nvim-treesitter",
        branch = "main",
        build = ":TSUpdate",
        lazy = false,
        config = function()
            vim.api.nvim_create_autocmd("FileType", {
                callback = function(args)
                    if vim.bo[args.buf].buftype == "" then
                        pcall(vim.treesitter.start, args.buf)
                    end
                end,
            })
        end,
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
