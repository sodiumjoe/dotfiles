local M = {}

local default_mapping_opts = { noremap = true, silent = true }

function M.is_executable(bin)
    return vim.fn.executable(bin) > 0
end

function M.path_exists(path)
    return (vim.uv or vim.loop).fs_stat(path)
end

function M.merge(a, b)
    return vim.tbl_extend("force", a, b)
end

function M.map(mappings)
    for _, m in pairs(mappings) do
        local mode = m[1]
        local lhs = m[2]
        local rhs = m[3]
        local opts = M.merge(default_mapping_opts, m[4] or {})
        vim.keymap.set(mode, lhs, rhs, opts)
    end
end

function M.augroup(name, augroup_opts)
    local group = vim.api.nvim_create_augroup(name, augroup_opts)
    return function(event, opts)
        vim.api.nvim_create_autocmd(event, vim.tbl_extend("force", { group = group }, opts))
    end
end

M.icons = {
    Error = " ",
    Warn = " ",
    Hint = " ",
    Info = " ",
    buffer = " ",
    lsp = " ",
    ok = " ",
}

M.spinner_frames = {
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
}

function M.is_project_local(root_pattern, config_file)
    local lspconfigUtil = require("lspconfig/util")
    local cwd = vim.fn.getcwd()
    local cwd_root_pattern = lspconfigUtil.path.join(cwd, root_pattern)
    local cwd_config_file = lspconfigUtil.path.join(cwd, config_file)
    if M.path_exists(cwd_root_pattern) then
        return M.path_exists(cwd_config_file)
    end
    local buf_name = vim.api.nvim_buf_get_name(0)
    return lspconfigUtil.root_pattern(root_pattern)(buf_name) == lspconfigUtil.root_pattern(config_file)(buf_name)
end

function M.find_git_ancestor(startpath)
    return vim.fs.dirname(vim.fs.find('.git', { path = startpath, upward = true })[1])
end

local severity_levels = {
    vim.diagnostic.severity.ERROR,
    vim.diagnostic.severity.WARN,
    vim.diagnostic.severity.INFO,
    vim.diagnostic.severity.HINT,
}

function M.get_highest_error_severity()
    for _, level in ipairs(severity_levels) do
        local diags = vim.diagnostic.get(0, { severity = { min = level } })
        if #diags > 0 then
            return level, diags
        end
    end
end

return M
