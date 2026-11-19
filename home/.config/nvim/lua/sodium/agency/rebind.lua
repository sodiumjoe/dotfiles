local M = {}

function M.managers()
    local Registry, Config = require("agentic.session_registry"), require("agentic.config")
    local managers = {}
    for tab, manager in pairs(Registry.sessions) do
        if vim.api.nvim_tabpage_is_valid(tab) and not manager._agency_destroyed
            and manager.agent.provider_config == Config.acp_providers.agency
            and type(manager.session_id) == "string" and manager.session_id:match("^agency:") then
            managers[#managers + 1] = manager
        end
    end
    return managers
end

local function reconnect(done)
    require("agentic.acp.agent_instance").get_instance("agency", function(client)
        client:when_ready(function() done() end)
    end)
end

function M.describe(summary)
    local text = summary.rebound .. " tab" .. (summary.rebound == 1 and "" or "s") .. " rebound"
    if summary.deferred > 0 then text = text .. ", " .. summary.deferred .. " after their turns" end
    if #summary.stopped > 0 then text = text .. ", " .. #summary.stopped .. (#summary.stopped == 1 and " tab's agent is" or " tabs' agents are") .. " stopped; reopen with <leader>ar" end
    if #summary.missing > 0 then text = text .. ", " .. #summary.missing .. " without a known agent" end
    if #summary.failed > 0 then
        local reasons = {}
        for _, item in ipairs(summary.failed) do reasons[#reasons + 1] = item.agentId:sub(1, 8) .. ": " .. tostring(item.error) end
        text = text .. ", " .. #summary.failed .. " failed to rebind (" .. table.concat(reasons, ", ") .. ")"
    end
    return text
end

function M.run(views, opts, callback)
    opts = opts or {}
    local ready, known = {}, {}
    for _, view in ipairs(views or {}) do
        if view.record.version == 3 then known[view.record.definition.agentId] = true end
        if view.record.version == 3 and view.live and view.record.phase == "ready" then ready[view.record.definition.agentId] = view end
    end
    local summary, settled = { rebound = 0, deferred = 0, stopped = {}, missing = {}, failed = {}, timed_out = false }, false
    local timer = assert(vim.uv.new_timer())
    timer:start(opts.timeout_ms or 30000, 0, vim.schedule_wrap(function()
        if settled then return end
        settled = true
        timer:close()
        summary.timed_out = true
        callback(summary)
    end))
    ;(opts.reconnect or reconnect)(vim.schedule_wrap(function()
        if settled then return end
        settled = true
        timer:stop()
        timer:close()
        local Adapter, current = require("sodium.agency.agentic"), vim.api.nvim_get_current_tabpage()
        local listed, managers = pcall(M.managers)
        local loading, opened, finished = {}, false, false
        local load_timer = assert(vim.uv.new_timer())
        local function finish()
            if finished or not opened or next(loading) then return end
            finished = true
            load_timer:stop()
            load_timer:close()
            callback(summary)
        end
        local function failed(agent_id, err)
            summary.failed[#summary.failed + 1] = { agentId = agent_id, error = type(err) == "table" and (err.message or err.code) or tostring(err) }
        end
        for _, manager in ipairs(listed and managers or {}) do
            local agent_id = manager.session_id:sub(8)
            local view = ready[agent_id]
            if not view then
                local list = known[agent_id] and summary.stopped or summary.missing
                list[#list + 1] = agent_id
            elseif opts.defer_busy and manager.is_generating then
                manager._agency_rebind = vim.deepcopy(view)
                summary.deferred = summary.deferred + 1
            else
                loading[manager] = agent_id
                manager._agency_load_done = function(err)
                    if loading[manager] == nil then return end
                    loading[manager] = nil
                    if err then failed(agent_id, err) else summary.rebound = summary.rebound + 1 end
                    finish()
                end
                local ok, err = pcall(Adapter.open, view, { force = true, quiet = true })
                if not ok and loading[manager] ~= nil then
                    loading[manager], manager._agency_load_done = nil, nil
                    failed(agent_id, err)
                end
            end
        end
        load_timer:start(opts.load_timeout_ms or 30000, 0, vim.schedule_wrap(function()
            for manager, agent_id in pairs(loading) do
                manager._agency_load_done = nil
                failed(agent_id, "the session load did not finish")
            end
            loading = {}
            finish()
        end))
        if vim.api.nvim_tabpage_is_valid(current) then vim.api.nvim_set_current_tabpage(current) end
        opened = true
        finish()
    end))
end

return M