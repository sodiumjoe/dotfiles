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

local function display_path(file, toplevel)
    return toplevel and vim.fs.relpath(toplevel, file) or file
end

local function filetype_from_path(path)
    local match = vim.filetype.match({ filename = path })
    return match
end

local function git_file_content(ref, filepath, toplevel)
    if not toplevel then
        toplevel = vim.fn.systemlist({ "git", "rev-parse", "--show-toplevel" })[1]
        if vim.v.shell_error ~= 0 or not toplevel then
            return nil, "not a git repository"
        end
    end
    local relpath = vim.fs.relpath(toplevel, filepath) or filepath
    local lines = vim.fn.systemlist({ "git", "-C", toplevel, "show", ref .. ":" .. relpath })
    if vim.v.shell_error ~= 0 then
        vim.fn.systemlist({ "git", "-C", toplevel, "rev-parse", "--verify", "--quiet", ref .. "^{commit}" })
        if vim.v.shell_error == 0 then
            return nil, "git show failed for " .. ref .. ":" .. relpath, "missing"
        end
        return nil, "git show failed for " .. ref .. ":" .. relpath
    end
    return lines
end

function M.open(opts)
    local utils = require("sodium.utils")
    require("sodium.agency.screen").focus_document()
    utils.close_non_agentic_windows()

    if opts.mode == "files" then
        vim.cmd.edit(opts.left)
        vim.cmd("diffthis")
        vim.cmd("vsplit " .. vim.fn.fnameescape(opts.right))
        vim.cmd("diffthis")
    elseif opts.mode == "refs" then
        local toplevel = opts.toplevel
        local ft = filetype_from_path(opts.file)

        if opts.right_ref then
            local left_lines = git_file_content(opts.left_ref, opts.file, toplevel) or {}
            local right_lines = git_file_content(opts.right_ref, opts.file, toplevel) or {}

            local display = display_path(opts.file, toplevel)
            local left_buf = scratch_buffer(display .. " (" .. opts.left_ref .. ")", left_lines, ft)
            local right_buf = scratch_buffer(display .. " (" .. opts.right_ref .. ")", right_lines, ft)

            vim.api.nvim_win_set_buf(0, left_buf)
            vim.cmd("diffthis")
            vim.cmd("vsplit")
            vim.api.nvim_win_set_buf(0, right_buf)
            vim.cmd("diffthis")
        else
            local left_lines, left_err, left_status = git_file_content(opts.left_ref, opts.file, toplevel)
            if not left_lines then
                if left_status == "missing" then
                    left_lines = {}
                else
                    vim.notify(left_err or "unknown error", vim.log.levels.ERROR)
                    return
                end
            end

            local display = display_path(opts.file, toplevel)
            local left_buf = scratch_buffer(display .. " (" .. opts.left_ref .. ")", left_lines, ft)

            vim.api.nvim_win_set_buf(0, left_buf)
            vim.cmd("diffthis")
            vim.cmd("vsplit " .. vim.fn.fnameescape(opts.file))
            vim.cmd("diffthis")
        end
    end
end

return M
