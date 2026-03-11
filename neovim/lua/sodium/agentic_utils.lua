local M = {}

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

return M