local M = {}

M._state = {
    current_pr = nil,
    reviewed = {},
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
    M._state = { current_pr = nil, reviewed = {} }
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

return M