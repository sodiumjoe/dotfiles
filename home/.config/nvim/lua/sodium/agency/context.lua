local M = {}

function M.resolve(path)
    local absolute = vim.fs.normalize(vim.fn.fnamemodify(path, ":p")):gsub("/$", "")
    if absolute == "" then
        absolute = "/"
    end
    local suffix, current = {}, absolute
    while current ~= "/" do
        local resolved = vim.uv.fs_realpath(current)
        if resolved then
            return vim.fs.normalize(resolved .. (#suffix > 0 and "/" .. table.concat(suffix, "/") or ""))
        end
        table.insert(suffix, 1, vim.fs.basename(current))
        current = vim.fs.dirname(current)
    end
    return "/" .. table.concat(suffix, "/")
end

function M.inside(cwd, path)
    cwd, path = M.resolve(cwd), M.resolve(path)
    return cwd == "/" or cwd == path or path:sub(1, #cwd + 1) == cwd .. "/"
end

function M.capture(bufnr, mode)
    bufnr = bufnr or vim.api.nvim_get_current_buf()
    local name = vim.api.nvim_buf_get_name(bufnr)
    local captured = {
        buffer = bufnr,
        tab = vim.api.nvim_get_current_tabpage(),
        cwd = vim.fn.getcwd(),
        path = name ~= "" and vim.fn.fnamemodify(name, ":p") or nil,
        lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false),
        modified = vim.bo[bufnr].modified or name == "" or vim.fn.filereadable(name) == 0,
        binary = vim.bo[bufnr].binary,
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

function M.annotations()
    local ok, store = pcall(require, "comment-overlay.store")
    if not ok then
        return {}
    end
    store.reload_if_changed()
    local project, items = store.get_project_root(), {}
    for _, file in ipairs(store.get_files_with_comments()) do
        for _, root in ipairs(store.get_for_file(file, { roots_only = true })) do
            if not root.resolved then
                local thread = vim.deepcopy(store.get_thread(root.id))
                local lines =
                    { "File: " .. project .. "/" .. file, "Line: " .. tostring(root.line_start or root.line or "?") }
                for _, comment in ipairs(thread) do
                    lines[#lines + 1] = comment.body
                end
                items[#items + 1] = {
                    id = root.id,
                    project = project,
                    path = project .. "/" .. file,
                    thread = thread,
                    text = table.concat(lines, "\n"),
                }
            end
        end
    end
    return items
end

function M.accept_annotations(captured)
    if #captured == 0 then
        return
    end
    local store = require("comment-overlay.store")
    store.reload_if_changed()
    local project = store.get_project_root()
    for _, item in ipairs(captured) do
        if project == item.project and vim.deep_equal(store.get_thread(item.id), item.thread) then
            store.delete(item.id)
        end
    end
    pcall(vim.cmd, "CommentRefresh")
end

function M.add(manager, captured, kind)
    if kind == "diagnostics" then manager.diagnostics_list:add_many(captured.diagnostics); return end
    if captured.selection then
        local selection = vim.deepcopy(captured.selection)
        selection.file_path = selection.file_path or "[buffer:" .. captured.buffer .. "]"
        manager.code_selection:add(selection)
    elseif captured.modified then
        manager.code_selection:add({ file_path = captured.path or "[buffer:" .. captured.buffer .. "]",
            file_type = captured.file_type or "", start_line = 1, end_line = #captured.lines,
            lines = vim.deepcopy(captured.lines) })
    elseif captured.path then manager.file_list:add(captured.path) end
end

return M