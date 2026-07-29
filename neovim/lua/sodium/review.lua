local M = {}

local function git(toplevel, args)
    local cmd = { "git", "-C", toplevel }
    vim.list_extend(cmd, args)
    local result = vim.system(cmd, { text = true }):wait()
    if result.code ~= 0 then
        return nil, vim.trim(result.stderr or "")
    end
    return vim.trim(result.stdout or "")
end

local function read_file(path)
    local f = io.open(path, "r")
    if not f then
        return nil
    end
    local content = f:read("*a")
    f:close()
    return content
end

M._state = {
    session = nil,
    reviewed = {},
    previous_branch = nil,
    current_user = nil,
    files = {},
    file_diffs = {},
}

function M.start_session(opts)
    local session = {
        id = tostring(opts.id),
        mode = opts.mode,
        base_ref = opts.base_ref,
        head_ref = opts.head_ref,
        toplevel = opts.toplevel,
    }
    M._state.session = session
    if not M._state.reviewed[session.id] then
        M._state.reviewed[session.id] = {}
    end
    return session
end

function M.get_session()
    return M._state.session
end

function M.reset()
    M._state = {
        session = nil,
        reviewed = {},
        previous_branch = nil,
        current_user = nil,
        files = {},
        file_diffs = {},
    }
end

function M.set_previous_branch(branch)
    M._state.previous_branch = branch
end

function M.get_previous_branch()
    return M._state.previous_branch
end

function M.set_current_user(user)
    M._state.current_user = user
end

function M.get_current_user()
    return M._state.current_user
end

function M.set_files(items)
    M._state.files = items or {}
end

function M.get_files()
    return M._state.files
end

function M.set_file_diffs(diffs)
    M._state.file_diffs = diffs or {}
end

function M.get_file_diffs()
    return M._state.file_diffs
end

function M.is_reviewed(filepath)
    local session = M._state.session
    if not session then
        return false
    end
    return M._state.reviewed[session.id][filepath] == true
end

function M.toggle_reviewed(filepath)
    local session = M._state.session
    if not session then
        return
    end
    local tbl = M._state.reviewed[session.id]
    if tbl[filepath] then
        tbl[filepath] = nil
    else
        tbl[filepath] = true
    end
    if session.mode == "pr" and session.toplevel then
        local path = session.toplevel .. "/.review/session.json"
        local data = M.read_comments_json(path)
        if data then
            data.reviewed = vim.tbl_keys(M._state.reviewed[session.id])
            table.sort(data.reviewed)
            M.write_comments_json(path, data)
        end
    end
end

function M.parse_pr_list(json_str)
    if not json_str then
        return {}
    end
    local ok, prs = pcall(vim.json.decode, json_str)
    if not ok or type(prs) ~= "table" then
        return {}
    end
    local items = {}
    for _, pr in ipairs(prs) do
        items[#items + 1] = {
            text = string.format("#%d %s", pr.number, pr.title),
            number = pr.number,
            title = pr.title,
            author = pr.author and pr.author.login or "",
            headRefName = pr.headRefName,
            baseRefName = pr.baseRefName,
            reviewDecision = pr.reviewDecision or "",
            isDraft = pr.isDraft or false,
        }
    end
    return items
end

function M.parse_changed_files(stdout)
    local files = {}
    for line in (stdout or ""):gmatch("[^\n]+") do
        if line ~= "" then
            files[#files + 1] = line
        end
    end
    return files
end

function M.base_candidates(origin_head, namespaces)
    local candidates = {}
    if origin_head and origin_head ~= "" then
        candidates[#candidates + 1] = origin_head
    end
    for _, namespace in ipairs(namespaces or {}) do
        candidates[#candidates + 1] = "origin/green-" .. namespace
        candidates[#candidates + 1] = "green-" .. namespace
    end
    vim.list_extend(candidates, { "main", "origin/main", "master", "origin/master" })
    return candidates
end

function M.build_file_items(toplevel, changed, untracked)
    local items = {}
    local function add(rel, is_untracked)
        local abs = toplevel .. "/" .. rel
        items[#items + 1] = {
            text = rel,
            file = abs,
            rel = rel,
            sort_idx = #items + 1,
            exists = vim.fn.filereadable(abs) == 1,
            untracked = is_untracked or false,
            reviewed = false,
        }
    end
    for _, rel in ipairs(changed or {}) do
        add(rel, false)
    end
    for _, rel in ipairs(untracked or {}) do
        add(rel, true)
    end
    return items
end

function M.detect_base(toplevel)
    local origin_head = git(toplevel, { "rev-parse", "--abbrev-ref", "origin/HEAD" })
    if origin_head then
        origin_head = origin_head:gsub("^origin/", "")
    end
    local namespaces = {}
    for _, namespace in ipairs({ "pay-server", "zoolander", "gocode" }) do
        if vim.fn.isdirectory(toplevel .. "/" .. namespace) == 1 then
            namespaces[#namespaces + 1] = namespace
        end
    end
    for _, candidate in ipairs(M.base_candidates(origin_head, namespaces)) do
        if git(toplevel, { "rev-parse", "--verify", "--quiet", candidate .. "^{commit}" }) then
            return candidate
        end
    end
    return nil
end

function M.start_self_review(base, toplevel)
    toplevel = toplevel or git(vim.fn.getcwd(), { "rev-parse", "--show-toplevel" })
    if not toplevel then
        vim.notify("Not a git repository", vim.log.levels.ERROR)
        return false
    end
    base = base or M.detect_base(toplevel)
    if not base then
        vim.notify("Could not detect base ref; pass one explicitly (:Review <ref>)", vim.log.levels.ERROR)
        return false
    end
    local merge_base = git(toplevel, { "merge-base", base, "HEAD" }) or base
    local diff = git(toplevel, { "diff", "--no-renames", merge_base }) or ""
    local names = git(toplevel, { "diff", "--no-renames", "--name-only", merge_base }) or ""
    local untracked = git(toplevel, { "ls-files", "--others", "--exclude-standard" }) or ""

    M.start_session({
        id = base,
        mode = "self",
        base_ref = merge_base,
        head_ref = nil,
        toplevel = toplevel,
    })
    M.set_file_diffs(M.parse_file_diffs(diff))
    M.set_files(M.build_file_items(toplevel, M.parse_changed_files(names), M.parse_changed_files(untracked)))
    return true
end

function M.load(toplevel)
    if not toplevel then
        local lines = vim.fn.systemlist({ "git", "rev-parse", "--show-toplevel" })
        if vim.v.shell_error ~= 0 then
            return false
        end
        toplevel = lines[1]
    end
    if not toplevel or toplevel == "" then
        return false
    end

    local dir = toplevel .. "/.review"
    local session = M.read_comments_json(dir .. "/session.json")
    if not session then
        return false
    end

    M.start_session(session)
    for _, rel in ipairs(session.reviewed or {}) do
        M._state.reviewed[tostring(session.id)][rel] = true
    end
    M.set_previous_branch(session.previous_branch)
    M.set_current_user(session.user)
    vim.g.comment_overlay_actor = session.user

    local diffs = M.parse_file_diffs(read_file(dir .. "/diff") or "")
    M.set_file_diffs(diffs)
    M.set_files(M.build_file_items(toplevel, M.parse_changed_files(read_file(dir .. "/files") or ""), {}))

    local raw_comments = read_file(dir .. "/pr-comments.json")
    if raw_comments and raw_comments ~= "" then
        local by_id, files = M.parse_gh_comments(raw_comments)
        if next(by_id) then
            M.write_comments_json(toplevel .. "/.nvim-comments.json", M.build_comments_v2(by_id, files))
            pcall(vim.cmd, "CommentRefresh")
        end
    end
    pcall(function()
        require("sodium.review_ui").show_help()
    end)
    return true
end

function M.parse_file_diffs(diff_text)
    if not diff_text or diff_text == "" then
        return {}, {}
    end
    local diffs = {}
    local files = {}
    local current_file = nil
    local current_lines = {}
    for line in diff_text:gmatch("[^\n]*\n?") do
        line = line:gsub("\n$", "")
        local b_path = line:match("^diff %-%-git a/.+ b/(.+)$")
        if b_path then
            if current_file then
                diffs[current_file] = table.concat(current_lines, "\n")
            end
            current_file = b_path
            files[#files + 1] = b_path
            current_lines = { line }
        elseif current_file then
            current_lines[#current_lines + 1] = line
        end
    end
    if current_file then
        diffs[current_file] = table.concat(current_lines, "\n")
    end
    return diffs, files
end

function M.parse_gh_comments(json_str)
    if not json_str then
        return {}, {}
    end
    local ok, comments = pcall(vim.json.decode, json_str)
    if not ok or type(comments) ~= "table" then
        return {}, {}
    end

    local by_id = {}
    local reply_map = {}
    local roots = {}

    for _, c in ipairs(comments) do
        if c.line and c.line ~= vim.NIL and c.path then
            local id = tostring(c.id)
            local entry = {
                id = id,
                file = c.path,
                line = c.line,
                body = string.format("%s: %s", c.user and c.user.login or "unknown", c.body or ""),
                actor = c.user and c.user.login or "unknown",
                created_at = c.created_at or "",
                resolved = false,
                kind = "comment",
                reply_ids = {},
            }
            by_id[id] = entry
            if c.in_reply_to_id then
                local parent_id = tostring(c.in_reply_to_id)
                entry.kind = "reply"
                entry.root_id = parent_id
                if not reply_map[parent_id] then
                    reply_map[parent_id] = {}
                end
                reply_map[parent_id][#reply_map[parent_id] + 1] = id
            else
                roots[#roots + 1] = id
            end
        end
    end

    for parent_id, replies in pairs(reply_map) do
        if by_id[parent_id] then
            by_id[parent_id].reply_ids = replies
        end
    end

    local files = {}
    for _, id in ipairs(roots) do
        local entry = by_id[id]
        if entry then
            if not files[entry.file] then
                files[entry.file] = {}
            end
            files[entry.file][#files[entry.file] + 1] = id
        end
    end

    return by_id, files
end

function M.build_comments_v2(by_id, files)
    return { comments = by_id, files = files }
end

function M.write_comments_json(path, data)
    local json = vim.json.encode(data)
    local f = io.open(path, "w")
    if not f then
        return false
    end
    f:write(json)
    f:close()
    return true
end

function M.read_comments_json(path)
    local f = io.open(path, "r")
    if not f then
        return nil
    end
    local content = f:read("*a")
    f:close()
    local ok2, data = pcall(vim.json.decode, content)
    if not ok2 then
        return nil
    end
    return data
end

return M
