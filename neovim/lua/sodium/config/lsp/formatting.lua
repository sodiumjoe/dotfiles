local utils = require("sodium.utils")

local M = {}

local autoformat_augroup = vim.api.nvim_create_augroup("LspFormatting", { clear = true })

function M.setup_format_on_save(client, bufnr)
    if not client:supports_method("textDocument/formatting") or utils.is_fugitive_buffer(bufnr) then
        return
    end

    vim.api.nvim_clear_autocmds({ group = autoformat_augroup, buffer = bufnr })
    vim.api.nvim_create_autocmd("BufWritePre", {
        group = autoformat_augroup,
        buffer = bufnr,
        callback = function()
            vim.lsp.buf.format({ timeout_ms = 30000 })
            vim.bo[bufnr].endofline = true
            vim.bo[bufnr].fixendofline = true
        end,
    })
end

return M
