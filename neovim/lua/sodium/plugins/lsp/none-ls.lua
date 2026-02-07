return {
    "nvimtools/none-ls.nvim",
    dependencies = { "nvim-lua/plenary.nvim" },
    config = function()
        local utils = require("sodium.utils")
        local formatting = require("sodium.config.lsp.formatting")
        local null_ls = require("null-ls")

        local sources = {
            null_ls.builtins.formatting.buildifier.with({
                condition = function(util)
                    return util.root_has_file({ "scripts/dev/buildifier" })
                end,
                command = "scripts/dev/buildifier",
            }),
            null_ls.builtins.diagnostics.rubocop.with({
                condition = function()
                    return utils.is_executable("scripts/bin/rubocop-daemon/rubocop")
                end,
                command = "scripts/bin/rubocop-daemon/rubocop",
            }),
            null_ls.builtins.formatting.prettier.with({
                prefer_local = "node_modules/.bin",
                condition = function(util)
                    return util.root_has_file("prettier.config.js")
                end,
            }),
            null_ls.builtins.formatting.stylua.with({
                condition = function()
                    return utils.is_executable("stylua")
                end,
            }),
        }

        null_ls.setup({
            sources = sources,
            should_attach = function(bufnr)
                return not utils.is_fugitive_buffer(bufnr)
            end,
            on_attach = formatting.setup_format_on_save,
        })
    end,
}
