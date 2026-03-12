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

return M