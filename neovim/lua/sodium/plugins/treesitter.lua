return {
    {
        "nvim-treesitter/nvim-treesitter",
        build = ":TSUpdate",
        main = "nvim-treesitter.configs",
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
        opts = {
            additional_vim_regex_highlighting = false,
            ensure_installed = {
                "bash",
                "css",
                "go",
                "html",
                "java",
                "javascript",
                "json",
                "lua",
                "markdown",
                "markdown_inline",
                "python",
                "regex",
                "ruby",
                "rust",
                "starlark",
                "tsx",
                "typescript",
                "vim",
                "yaml",
            },
            ignore_install = { "comment", "jsdoc" },
            highlight = {
                enable = true,
                disable = {},
            },
        },
    },
    "nvim-treesitter/nvim-treesitter-context",
    {
        "nvim-treesitter/playground",
        opts = {
            playground = {
                enable = true,
                disable = {},
                updatetime = 25,
                persist_queries = false,
                keybindings = {
                    toggle_query_editor = "o",
                    toggle_hl_groups = "i",
                    toggle_injected_languages = "t",
                    toggle_anonymous_nodes = "a",
                    toggle_language_display = "I",
                    focus_language = "f",
                    unfocus_language = "F",
                    update = "R",
                    goto_node = "<cr>",
                    show_help = "?",
                },
            },
        },
        cmd = { "TSPlaygroundToggle" },
        lazy = true,
    },
}
