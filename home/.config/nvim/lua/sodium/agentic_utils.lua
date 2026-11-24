local M = {}

M.work_bin = vim.env.HOME .. "/bin/work"
M.projects_dir = vim.env.HOME .. "/stripe/work/projects/"

M.state_cycle = { [" "] = "in-progress", ["/"] = "done", ["x"] = "open" }
M.state_char = { ["in-progress"] = "/", ["done"] = "x", ["open"] = " " }
M.state_display = { [" "] = "[ ]", ["/"] = "[/]", ["x"] = "[x]" }

function M.slugify(title)
    return title:lower():gsub("[^%w]+", "-"):gsub("^-+", ""):gsub("-+$", "")
end

function M.parse_task_items(stdout)
    local items = {}
    for line in (stdout or ""):gmatch("[^\n]+") do
        local file, line_num, state, title, description = line:match("^(.-)\t(.-)\t(.)\t(.-)\t(.-)$")
        if file then
            items[#items + 1] = {
                text = description,
                file = file,
                line_num = tonumber(line_num),
                state = state,
                title = title,
                description = description,
            }
        end
    end
    return items
end

function M.sort_by_score(a, b)
    if a.score ~= b.score then
        return a.score > b.score
    end
    return a.sort_idx < b.sort_idx
end

function M.file_preview(ctx)
    local item = ctx.item
    if not item or not item.file then
        return
    end
    local lines = vim.fn.readfile(item.file)
    ctx.preview:set_lines(lines)
end

function M.project_format(item)
    local ret = { { item.text } }
    if item.status == "evergreen" then
        ret[#ret + 1] = { " (evergreen)", "SnacksPickerDir" }
    end
    return ret
end

function M.list_projects(callback)
    vim.system({ M.work_bin, "list-projects" }, { text = true }, function(result)
        vim.schedule(function()
            local items = {}
            for line in (result.stdout or ""):gmatch("[^\n]+") do
                local slug, title, status = line:match("^(.-)\t(.-)\t(.-)$")
                if slug then
                    items[#items + 1] = {
                        text = title,
                        slug = slug,
                        status = status,
                        file = M.projects_dir .. slug .. "/project.md",
                    }
                end
            end
            callback(items)
        end)
    end)
end

function M.create_project(callback)
    vim.ui.input({ prompt = "Project title: " }, function(title)
        if not title or title == "" then
            return
        end
        local slug = M.slugify(title)
        vim.system({ M.work_bin, "create-project", slug, title }, { text = true }, function(result)
            vim.schedule(function()
                if result.code ~= 0 then
                    vim.notify("create-project failed: " .. (result.stderr or ""), vim.log.levels.ERROR)
                    return
                end
                callback(slug, title, M.projects_dir .. slug .. "/project.md")
            end)
        end)
    end)
end

return M
