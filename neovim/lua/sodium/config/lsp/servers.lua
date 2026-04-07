local utils = require("sodium.utils")
local formatting = require("sodium.config.lsp.formatting")

local function on_attach(client, bufnr)
    formatting.setup_format_on_save(client, bufnr)
    require("lspkind").init({})
end

-- Global capabilities (augmented with blink.cmp completions)
local blink = require("blink.cmp")
vim.lsp.config("*", {
    capabilities = blink.get_lsp_capabilities(vim.lsp.protocol.make_client_capabilities()),
})

vim.lsp.config("bazel", {
    cmd = { "scripts/dev/bazel-lsp" },
    filetypes = { "bzl" },
    root_markers = { "WORKSPACE", "WORKSPACE.bazel", "MODULE.bazel" },
})

vim.lsp.config("rust_analyzer", {
    cmd = { "rust-analyzer" },
    filetypes = { "rust" },
    root_markers = { "Cargo.toml" },
    settings = {
        ["rust-analyzer"] = {
            cargo = { features = "all" },
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
    cmd = { "vscode-eslint-language-server", "--stdio" },
    filetypes = { "javascript", "javascriptreact", "typescript", "typescriptreact" },
    root_markers = { ".eslintrc", ".eslintrc.js", ".eslintrc.json", "eslint.config.js", "eslint.config.mjs" },
    cmd_env = { BROWSERSLIST_IGNORE_OLD_DATA = "1" },
    handlers = {
        ["textDocument/diagnostic"] = function(_, result, ctx)
            if result == nil or result.items == nil then
                return
            end
            local idx = 1
            while idx <= #result.items do
                if result.items[idx].code == "prettier/prettier" then
                    table.remove(result.items, idx)
                else
                    idx = idx + 1
                end
            end
            vim.lsp.diagnostic.on_diagnostic(_, result, ctx)
        end,
    },
})

vim.lsp.config("flow", {
    cmd = { "flow", "lsp" },
    filetypes = { "javascript", "javascriptreact" },
    root_markers = { ".flowconfig" },
})

vim.lsp.config("tsgo", {
    cmd = { "tsgo", "--lsp" },
    filetypes = { "typescript", "typescriptreact" },
    root_markers = { "tsconfig.json" },
})

vim.lsp.config("lua_ls", {
    cmd = { "lua-language-server" },
    filetypes = { "lua" },
    root_markers = { ".luarc.json", ".luarc.jsonc", ".stylua.toml", "stylua.toml" },
})

vim.lsp.config("efm", {
    cmd = { "efm-langserver" },
    filetypes = {
        "lua",
        "javascript",
        "javascriptreact",
        "typescript",
        "typescriptreact",
        "css",
        "json",
        "bzl",
        "ruby",
    },
    init_options = { documentFormatting = true },
    root_markers = { ".git" },
})

-- LspAttach autocmd
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
    end,
})

-- Enable servers (only if executable is available)
local lsp_servers = {
    { "rust_analyzer", "rust-analyzer" },
    { "bazel", nil },
    { "sorbet", nil },
    { "eslint", nil },
    { "flow", "flow" },
    { "tsgo", nil },
    { "lua_ls", "lua-language-server" },
    { "efm", "efm-langserver" },
}

local enabled_servers = {}
for _, entry in ipairs(lsp_servers) do
    local server, executable = entry[1], entry[2]
    if executable == nil or vim.fn.executable(executable) == 1 then
        table.insert(enabled_servers, server)
    end
end

vim.lsp.enable(enabled_servers)
