local utils = require("sodium.utils")

local M = {}

M.window_opts = {
    win_opts = {
        foldcolumn = "1",
    },
}

M.virtual_lines_config = {
    format = utils.virtual_lines_format,
    current_line = true,
}

M.diagnostic_config = {
    signs = {
        text = {
            [vim.diagnostic.severity.ERROR] = "",
            [vim.diagnostic.severity.WARN] = "",
            [vim.diagnostic.severity.HINT] = "",
            [vim.diagnostic.severity.INFO] = "",
        },
        numhl = {
            [vim.diagnostic.severity.ERROR] = "DiagnosticSignError",
            [vim.diagnostic.severity.WARN] = "DiagnosticSignWarn",
            [vim.diagnostic.severity.HINT] = "DiagnosticSignHint",
            [vim.diagnostic.severity.INFO] = "DiagnosticSignInfo",
        },
    },
    severity_sort = true,
    virtual_text = false,
    virtual_lines = M.virtual_lines_config,
    update_in_insert = false,
    float = {
        focusable = false,
        format = function(diagnostic)
            local str = string.format("[%s] %s", diagnostic.source, diagnostic.message)
            if diagnostic.code then
                str = str .. " (" .. diagnostic.code .. ")"
            end
            return str
        end,
    },
}

vim.diagnostic.config(M.diagnostic_config)

return M
