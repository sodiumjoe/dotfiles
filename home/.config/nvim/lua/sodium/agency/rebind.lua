local M = {}

local function agency_managers()
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

function M.run(views, opts, callback)
    opts = opts or {}
    local ready = {}
    for _, view in ipairs(views or {}) do
        if view.record.version == 3 and view.live and view.record.phase == "ready" then ready[view.record.definition.agentId] = view end
    end
    local summary, settled = { rebound = 0, deferred = 0, missing = {}, timed_out = false }, false
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
        for _, manager in ipairs(agency_managers()) do
            local agent_id = manager.session_id:sub(8)
            local view = ready[agent_id]
            if not view then
                summary.missing[#summary.missing + 1] = agent_id
            elseif opts.defer_busy and manager.is_generating then
                manager._agency_rebind = vim.deepcopy(view)
                summary.deferred = summary.deferred + 1
            else
                Adapter.open(view, { force = true, quiet = true })
                summary.rebound = summary.rebound + 1
            end
        end
        if vim.api.nvim_tabpage_is_valid(current) then vim.api.nvim_set_current_tabpage(current) end
        callback(summary)
    end))
end

return M