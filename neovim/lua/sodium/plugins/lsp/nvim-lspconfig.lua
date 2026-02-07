return {
    "neovim/nvim-lspconfig",
    dependencies = {
        "saghen/blink.cmp",
        "onsails/lspkind-nvim",
    },
    config = function()
        local utils = require("sodium.utils")
        local diagnostics = require("sodium.config.diagnostics")
        local formatting = require("sodium.config.lsp.formatting")
        local blink = require("blink.cmp")

        local on_attach = function(client, bufnr)
            formatting.setup_format_on_save(client, bufnr)
            require("lspkind").init({})
            require("sodium.statusline").on_attach()
        end

        local base_capabilities = blink.get_lsp_capabilities(vim.lsp.protocol.make_client_capabilities())

        vim.lsp.config("*", {
            capabilities = base_capabilities,
        })

        vim.lsp.config("bazel", {
            cmd = { "pay", "exec", "scripts/dev/bazel-lsp" },
            filetypes = { "star", "bzl", "BUILD.bazel" },
            root_markers = { ".git" },
        })

        vim.lsp.config("rust_analyzer", {
            filetypes = { "rust" },
            root_markers = { "Cargo.toml" },
            settings = {
                ["rust-analyzer"] = {
                    cargo = {
                        features = "all",
                    },
                },
            },
        })

        vim.lsp.config("sorbet", {
            cmd = {
                "pay",
                "exec",
                "scripts/bin/typecheck",
                "--lsp",
                "--enable-all-experimental-lsp-features",
            },
            init_options = {
                supportsOperationNotifications = true,
                supportsSorbetURIs = true,
            },
            settings = {},
        })

        vim.lsp.config("eslint", {
            cmd_env = { BROWSERSLIST_IGNORE_OLD_DATA = "1" },
            handlers = {
                ["textDocument/diagnostic"] = function(_, result, ctx)
                    if result == nil or result.items == nil then
                        return
                    end

                    local idx = 1
                    while idx <= #result.items do
                        local entry = result.items[idx]
                        if entry.code == "prettier/prettier" then
                            table.remove(result.items, idx)
                        else
                            idx = idx + 1
                        end
                    end

                    vim.lsp.diagnostic.on_diagnostic(_, result, ctx)
                end,
            },
        })

        vim.lsp.config("flow", {})

        vim.lsp.config("tsgo", {})

        vim.lsp.config("lua_ls", {})

        local lsp_attach_group = vim.api.nvim_create_augroup("UserLspAttach", { clear = true })
        vim.api.nvim_create_autocmd("LspAttach", {
            group = lsp_attach_group,
            callback = function(args)
                if utils.is_fugitive_buffer(args.buf) then
                    vim.schedule(function()
                        vim.diagnostic.enable(false, { bufnr = args.buf })
                    end)
                    return
                end

                local client = vim.lsp.get_client_by_id(args.data.client_id)
                if not client then
                    return
                end

                on_attach(client, args.buf)

                if client.name == "eslint" then
                    vim.api.nvim_create_autocmd("BufWritePre", {
                        buffer = args.buf,
                        command = "LspEslintFixAll",
                    })
                end
            end,
        })

        local lsp_servers = {
            { "rust_analyzer", "rust-analyzer" },
            { "bazel", nil },
            { "sorbet", nil },
            { "eslint", nil },
            { "flow", "flow" },
            { "tsgo", nil },
            { "lua_ls", "lua-language-server" },
        }

        local enabled_servers = {}
        for _, entry in ipairs(lsp_servers) do
            local server, executable = entry[1], entry[2]
            if executable == nil or vim.fn.executable(executable) == 1 then
                table.insert(enabled_servers, server)
            end
        end

        vim.lsp.enable(enabled_servers)
    end,
    keys = {
        { "gD", vim.lsp.buf.declaration },
        {
            "K",
            function()
                vim.lsp.buf.hover({ focusable = false })
            end,
        },
        { "gi", vim.lsp.buf.implementation },
        { [[<leader>D]], vim.lsp.buf.type_definition },
        { [[<leader>ca]], vim.lsp.buf.code_action },
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
                vim.lsp.buf.format({ timeout_ms = 30000 })
            end,
        },
    },
    lazy = false,
}
