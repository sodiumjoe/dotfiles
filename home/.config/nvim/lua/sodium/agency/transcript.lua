local M = {}
local Control = require("sodium.agency.control")
local titles = { user = "User", agent = "Agent" }

local function notify(value, level) vim.notify("Agency: " .. tostring(value), level) end

function M.lines(result)
    if #result.turns == 0 then return { "No conversation text yet." } end
    local lines = result.truncated and { "> Older turns were not kept.", "" } or {}
    for index, turn in ipairs(result.turns) do
        if index > 1 then lines[#lines + 1] = "" end
        vim.list_extend(lines, { "## " .. (titles[turn.role] or turn.role), "" })
        vim.list_extend(lines, vim.split(turn.text, "\n", { plain = true }))
    end
    return lines
end

local function buffer(name)
    for _, buf in ipairs(vim.api.nvim_list_bufs()) do
        if vim.api.nvim_buf_get_name(buf) == name then return buf end
    end
    local buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_name(buf, name)
    vim.bo[buf].buftype, vim.bo[buf].bufhidden, vim.bo[buf].filetype = "nofile", "wipe", "markdown"
    return buf
end

local function show(agent_id, result)
    local buf = buffer("agency://transcript/" .. agent_id)
    vim.bo[buf].modifiable = true
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, M.lines(result))
    vim.bo[buf].modifiable = false
    local win = require("sodium.agency.screen").ensure_document(buf)
    vim.api.nvim_win_set_buf(win, buf)
    vim.api.nvim_win_set_cursor(win, { 1, 0 })
    vim.api.nvim_set_current_win(win)
end

function M.open(manager)
    manager = manager or require("sodium.agency.screen").manager()
    if not manager then notify("No Agency session in this tab", vim.log.levels.WARN); return end
    local agent_id = Control.agent_id(manager.session_id)
    if not agent_id then notify("The Agency session has no agent yet", vim.log.levels.WARN); return end
    require("sodium.agency.roster").request("agency/transcript", { agentId = agent_id }, function(err, envelope)
        if err then notify(err.message or err.code, vim.log.levels.ERROR); return end
        show(agent_id, envelope.result)
    end, { timeout_ms = 15000 })
end

return M