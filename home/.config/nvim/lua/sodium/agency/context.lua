local M = {}

function M.capture(bufnr, mode)
    bufnr = bufnr or vim.api.nvim_get_current_buf()
    local name = vim.api.nvim_buf_get_name(bufnr)
    local captured = {
        buffer = bufnr,
        cwd = vim.fn.getcwd(),
        path = name ~= "" and vim.fn.fnamemodify(name, ":p") or nil,
        lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false),
        modified = vim.bo[bufnr].modified or name == "" or vim.fn.filereadable(name) == 0,
        binary = vim.bo[bufnr].binary,
        buftype = vim.bo[bufnr].buftype,
        file_type = vim.bo[bufnr].filetype,
        diagnostics = {},
    }
    for _, diagnostic in ipairs(vim.diagnostic.get(bufnr)) do
        local value = vim.deepcopy(diagnostic)
        value.file_path = captured.path or ""
        captured.diagnostics[#captured.diagnostics + 1] = value
    end
    if type(mode) == "table" or mode == "v" or mode == "V" then
        local first = type(mode) == "table" and mode.first or vim.fn.getpos("v")[2]
        local last = type(mode) == "table" and mode.last or vim.api.nvim_win_get_cursor(0)[1]
        first, last = math.min(first, last), math.max(first, last)
        captured.selection = {
            buffer = bufnr,
            file_path = captured.path,
            file_type = captured.file_type,
            start_line = first,
            end_line = last,
            lines = vim.api.nvim_buf_get_lines(bufnr, first - 1, last, false),
            binary = captured.binary,
        }
    end
    return captured
end

function M.add(manager, captured, kind)
    if kind == "diagnostics" then manager.diagnostics_list:add_many(captured.diagnostics); return end
    if captured.selection then
        local selection = vim.deepcopy(captured.selection)
        selection.file_path = selection.file_path or "[buffer:" .. captured.buffer .. "]"
        manager.code_selection:add(selection)
    elseif not captured.path and captured.buftype == "nofile" and vim.deep_equal(captured.lines, { "" }) then return
    elseif captured.modified then
        manager.code_selection:add({ file_path = captured.path or "[buffer:" .. captured.buffer .. "]",
            file_type = captured.file_type or "", start_line = 1, end_line = #captured.lines,
            lines = vim.deepcopy(captured.lines) })
    elseif captured.path then manager.file_list:add(captured.path) end
end

function M.stage(manager, content, accepted, rejected)
    manager._agency_pending_context = manager._agency_pending_context or {}
    local entry = { content = vim.deepcopy(content), accepted = accepted, rejected = rejected }
    table.insert(manager._agency_pending_context, entry)
    return entry
end

function M.unstage(manager, entry)
    for index, value in ipairs(manager._agency_pending_context or {}) do
        if value == entry then table.remove(manager._agency_pending_context, index); return end
    end
end

return M