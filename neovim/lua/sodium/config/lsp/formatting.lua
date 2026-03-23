local utils = require("sodium.utils")

local M = {}

local autoformat_augroup = vim.api.nvim_create_augroup("LspFormatting", { clear = true })

local function get_format_client(bufnr)
    local efm_attached = #vim.lsp.get_clients({ bufnr = bufnr, name = "efm" }) > 0
    local name = efm_attached and "efm" or nil
    local clients = vim.lsp.get_clients({
        bufnr = bufnr,
        name = name,
        method = "textDocument/formatting",
    })
    return clients[1]
end

function M.format(bufnr)
    local client = get_format_client(bufnr)
    if not client then return end
    vim.lsp.buf.format({
        timeout_ms = 30000,
        async = true,
        name = client.name,
    })
end

function M.setup_format_on_save(client, bufnr)
    if not client:supports_method("textDocument/formatting") or utils.is_fugitive_buffer(bufnr) then
        return
    end

    vim.api.nvim_clear_autocmds({ group = autoformat_augroup, buffer = bufnr })
    vim.api.nvim_create_autocmd("BufWritePre", {
        group = autoformat_augroup,
        buffer = bufnr,
        callback = function()
            vim.bo[bufnr].endofline = true
            vim.bo[bufnr].fixendofline = true
        end,
    })
    if not M._leave_autocmd then
        M._leave_autocmd = true
        vim.api.nvim_create_autocmd("VimLeavePre", {
            group = autoformat_augroup,
            callback = function()
                local function any_formatting()
                    for _, b in ipairs(vim.api.nvim_list_bufs()) do
                        if vim.api.nvim_buf_is_valid(b) and vim.b[b].formatting then
                            return true
                        end
                    end
                    return false
                end
                if any_formatting() then
                    vim.wait(5000, function() return not any_formatting() end, 50)
                end
            end,
        })
    end
    vim.api.nvim_create_autocmd("BufWritePost", {
        group = autoformat_augroup,
        buffer = bufnr,
        callback = function()
            if vim.b[bufnr].formatting then return end
            local fmt_client = get_format_client(bufnr)
            if not fmt_client then return end

            vim.b[bufnr].formatting = true
            local changedtick = vim.api.nvim_buf_get_changedtick(bufnr)

            fmt_client:request("textDocument/formatting", vim.lsp.util.make_formatting_params(), function(err, result)
                vim.b[bufnr].formatting = false
                if err or not result or #result == 0 then return end
                if not vim.api.nvim_buf_is_valid(bufnr) then return end
                if vim.api.nvim_buf_get_changedtick(bufnr) ~= changedtick then return end

                vim.schedule(function()
                    vim.lsp.util.apply_text_edits(result, bufnr, fmt_client.offset_encoding)
                    if vim.bo[bufnr].modified then
                        vim.api.nvim_buf_call(bufnr, function()
                            vim.cmd("noautocmd write")
                        end)
                    end
                end)
            end, bufnr)
        end,
    })
end

return M
