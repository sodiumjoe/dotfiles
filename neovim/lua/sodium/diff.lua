local M = {}

local function scratch_buffer(name, lines, filetype)
    local buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
    vim.api.nvim_buf_set_name(buf, name)
    vim.bo[buf].buftype = "nofile"
    vim.bo[buf].bufhidden = "wipe"
    vim.bo[buf].modifiable = false
    if filetype then
        vim.bo[buf].filetype = filetype
    end
    return buf
end

local function filetype_from_path(path)
    local match = vim.filetype.match({ filename = path })
    return match
end

local function git_file_content(ref, filepath)
    local toplevel = vim.fn.systemlist({ "git", "rev-parse", "--show-toplevel" })[1]
    if vim.v.shell_error ~= 0 or not toplevel then
        return nil, "not a git repository"
    end
    local relpath = vim.fn.fnamemodify(filepath, ":.")
    if vim.startswith(filepath, "/") and toplevel then
        relpath = filepath:sub(#toplevel + 2)
    end
    local lines = vim.fn.systemlist({ "git", "show", ref .. ":" .. relpath })
    if vim.v.shell_error ~= 0 then
        return nil, "git show failed for " .. ref .. ":" .. relpath
    end
    return lines
end

function M.open(opts)
    local utils = require("sodium.utils")
    local win = utils.editor_window()
    if win then
        vim.api.nvim_set_current_win(win)
    end
    for _, w in ipairs(vim.api.nvim_list_wins()) do
        if w ~= vim.api.nvim_get_current_win() then
            local ft = vim.api.nvim_get_option_value("filetype", { buf = vim.api.nvim_win_get_buf(w) })
            if not ft:match("^Agentic") then
                pcall(vim.api.nvim_win_close, w, true)
            end
        end
    end

    if opts.mode == "files" then
        vim.cmd.edit(opts.left)
        vim.cmd("diffthis")
        vim.cmd("vsplit " .. vim.fn.fnameescape(opts.right))
        vim.cmd("diffthis")
    elseif opts.mode == "refs" then
        local ft = filetype_from_path(opts.file)

        if opts.right_ref then
            local left_lines, left_err = git_file_content(opts.left_ref, opts.file)
            if not left_lines then
                vim.notify(left_err, vim.log.levels.ERROR)
                return
            end
            local right_lines, right_err = git_file_content(opts.right_ref, opts.file)
            if not right_lines then
                vim.notify(right_err, vim.log.levels.ERROR)
                return
            end

            local basename = vim.fn.fnamemodify(opts.file, ":t")
            local left_buf = scratch_buffer(basename .. " (" .. opts.left_ref .. ")", left_lines, ft)
            local right_buf = scratch_buffer(basename .. " (" .. opts.right_ref .. ")", right_lines, ft)

            vim.api.nvim_win_set_buf(0, left_buf)
            vim.cmd("diffthis")
            vim.cmd("vsplit")
            vim.api.nvim_win_set_buf(0, right_buf)
            vim.cmd("diffthis")
        else
            local left_lines, left_err = git_file_content(opts.left_ref, opts.file)
            if not left_lines then
                vim.notify(left_err, vim.log.levels.ERROR)
                return
            end

            local basename = vim.fn.fnamemodify(opts.file, ":t")
            local left_buf = scratch_buffer(basename .. " (" .. opts.left_ref .. ")", left_lines, ft)

            vim.api.nvim_win_set_buf(0, left_buf)
            vim.cmd("diffthis")
            vim.cmd("vsplit " .. vim.fn.fnameescape(opts.file))
            vim.cmd("diffthis")
        end
    end
end

M._scratch_buffer = scratch_buffer
M._filetype_from_path = filetype_from_path

return M
