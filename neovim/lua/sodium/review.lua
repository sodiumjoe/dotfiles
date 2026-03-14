local M = {}

M._state = {
    current_pr = nil,
    reviewed = {},
    previous_branch = nil,
    current_user = nil,
}

function M.set_current_pr(pr)
    M._state.current_pr = pr
    if pr and not M._state.reviewed[pr.number] then
        M._state.reviewed[pr.number] = {}
    end
end

function M.get_current_pr()
    return M._state.current_pr
end

function M.reset()
    M._state = { current_pr = nil, reviewed = {}, previous_branch = nil, current_user = nil }
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

function M.is_reviewed(filepath)
    local pr = M._state.current_pr
    if not pr then return false end
    return M._state.reviewed[pr.number][filepath] == true
end

function M.toggle_reviewed(filepath)
    local pr = M._state.current_pr
    if not pr then return end
    local tbl = M._state.reviewed[pr.number]
    if tbl[filepath] then
        tbl[filepath] = nil
    else
        tbl[filepath] = true
    end
end

function M.parse_pr_list(json_str)
    if not json_str then return {} end
    local ok, prs = pcall(vim.json.decode, json_str)
    if not ok or type(prs) ~= "table" then return {} end
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

function M.parse_file_diffs(diff_text)
    if not diff_text or diff_text == "" then return {}, {} end
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
    if not json_str then return {}, {} end
    local ok, comments = pcall(vim.json.decode, json_str)
    if not ok or type(comments) ~= "table" then return {}, {} end

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
    if not f then return false end
    f:write(json)
    f:close()
    return true
end

function M.read_comments_json(path)
    local f = io.open(path, "r")
    if not f then return nil end
    local content = f:read("*a")
    f:close()
    local ok2, data = pcall(vim.json.decode, content)
    if not ok2 then return nil end
    return data
end

function M.filter_local_comments(data, current_user)
    if not data or not data.comments or not current_user then return {} end
    local result = {}
    for id, comment in pairs(data.comments) do
        local author = comment.actor or comment.author
        if author == current_user and not tonumber(id) then
            result[#result + 1] = comment
        end
    end
    return result
end

return M