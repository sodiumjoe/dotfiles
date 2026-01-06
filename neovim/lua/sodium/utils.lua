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
    local cwd_root_pattern = table.concat({ cwd, root_pattern }, "/")
    local cwd_config_file = table.concat({ cwd, config_file }, "/")
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

-- The following is from
-- https://github.com/joe-p/kickstart.nvim/blob/4f756cf63ec2d4eea293918e086096ff984eebc9/lua/joe-p/diagnostic.lua to
-- workaround for https://github.com/neovim/neovim/issues/18282

-- Get the window id for a buffer
-- @param bufnr integer
local function buf_to_win(bufnr)
    local current_win = vim.fn.win_getid()

    -- Check if current window has the buffer
    if vim.fn.winbufnr(current_win) == bufnr then
        return current_win
    end

    -- Otherwise, find a visible window with this buffer
    local win_ids = vim.fn.win_findbuf(bufnr)
    local current_tabpage = vim.fn.tabpagenr()

    for _, win_id in ipairs(win_ids) do
        if vim.fn.win_id2tabwin(win_id)[1] == current_tabpage then
            return win_id
        end
    end

    return current_win
end

-- Split a string into multiple lines, each no longer than max_width
-- The split will only occur on spaces to preserve readability
-- @param str string
-- @param max_width integer
local function split_line(str, max_width)
    if #str <= max_width then
        return { str }
    end

    local lines = {}
    local current_line = ''

    for word in string.gmatch(str, '%S+') do
        -- If adding this word would exceed max_width
        if #current_line + #word + 1 > max_width then
            -- Add the current line to our results
            table.insert(lines, current_line)
            current_line = word
        else
            -- Add word to the current line with a space if needed
            if current_line ~= '' then
                current_line = current_line .. ' ' .. word
            else
                current_line = word
            end
        end
    end

    -- Don't forget the last line
    if current_line ~= '' then
        table.insert(lines, current_line)
    end

    return lines
end

---@param diagnostic vim.Diagnostic
function M.virtual_lines_format(diagnostic)
    local win = buf_to_win(diagnostic.bufnr)
    local sign_column_width = vim.fn.getwininfo(win)[1].textoff
    local text_area_width = vim.api.nvim_win_get_width(win) - sign_column_width
    local center_width = 5
    local left_width = 1

    local severity_icons = {
        [vim.diagnostic.severity.ERROR] = M.icons.Error,
        [vim.diagnostic.severity.WARN] = M.icons.Warn,
        [vim.diagnostic.severity.INFO] = M.icons.Info,
        [vim.diagnostic.severity.HINT] = M.icons.Hint,
    }
    local icon = severity_icons[diagnostic.severity] or ''
    local source = diagnostic.source and ('[' .. diagnostic.source .. '] ') or ''

    ---@type string[]
    local lines = {}
    for msg_line in diagnostic.message:gmatch '([^\n]+)' do
        local max_width = text_area_width - diagnostic.col - center_width - left_width
        vim.list_extend(lines, split_line(msg_line, max_width))
    end

    return icon .. source .. table.concat(lines, '\n')
end

-- Re-draw diagnostics each line change to account for virtual_text changes
local last_line = vim.fn.line '.'

vim.api.nvim_create_autocmd({ 'CursorMoved' }, {
    callback = function()
        local current_line = vim.fn.line '.'

        -- Check if the cursor has moved to a different line
        if current_line ~= last_line then
            vim.diagnostic.hide()
            vim.diagnostic.show()
        end

        -- Update the last_line variable
        last_line = current_line
    end,
})

-- Re-render diagnostics when the window is resized

vim.api.nvim_create_autocmd('VimResized', {
    callback = function()
        vim.diagnostic.hide()
        vim.diagnostic.show()
    end,
})

return M
