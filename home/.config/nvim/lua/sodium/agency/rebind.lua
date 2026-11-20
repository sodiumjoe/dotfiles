local M = {}

function M.agency(manager)
    return manager ~= nil and not manager._destroyed and manager.agent.provider_config == require("agentic.config").acp_providers.agency
end

function M.managers()
    local managers = {}
    for _, manager in ipairs(require("agentic.session_registry").list()) do
        if M.agency(manager) and type(manager.session_id) == "string" and manager.session_id:match("^agency:") then managers[#managers + 1] = manager end
    end
    return managers
end

function M.holder(id, agent)
    for _, manager in ipairs(require("agentic.session_registry").list()) do
        if manager.agent == agent and manager.session_id == id and not manager._destroyed then return manager end
    end
end

local function tuple(view)
    local record = view and view.record
    if not record or record.version ~= 3 or not record.launch or record.launch == vim.NIL then return end
    return { agentId = record.definition.agentId, handlerGeneration = record.launch.handlerGeneration,
        providerGeneration = record.launch.providerGeneration }
end

function M.dead(manager, live)
    return manager._agency_unavailable == true or manager._agency_binding ~= nil and not vim.deep_equal(manager._agency_binding, live)
end

function M.reason(err)
    if type(err) ~= "table" then return err and tostring(err) or "the session did not start" end
    if err.code == require("agentic.acp.acp_client").ERROR_CODES.TRANSPORT_ERROR and err.data == nil
        and (err.message == "disconnected" or err.message == "error") then return "the connection ended before the session loaded" end
    return err.message or tostring(err.code)
end

local function migrate(source, target)
    local input = source.widget.buf_nrs.input
    local lines = vim.api.nvim_buf_is_valid(input) and vim.api.nvim_buf_get_lines(input, 0, -1, false) or {}
    if table.concat(lines, "\n"):match("%S") then
        require("agentic.utils.buf_helpers").with_modifiable(target.widget.buf_nrs.input, function(buffer)
            vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
        end)
    end
    for _, file in ipairs(source.file_list:get_files()) do target.file_list:add(file) end
    for _, selection in ipairs(source.code_selection:get_selections()) do target.code_selection:add(selection) end
    target.diagnostics_list:add_many(source.diagnostics_list:get_diagnostics())
    target._agency_pending_context = source._agency_pending_context
    for _, entry in ipairs(target._agency_pending_context or {}) do entry.submission = nil end
end

function M.reattach(manager, view)
    return require("agentic.session_registry").replace(manager, "agency", { kind = "load", session_id = manager.session_id,
        cwd = manager._agency_cwd or view and view.record.definition.cwd, title = manager.chat_history.title },
        { agent = manager.agent, reattach = true, prepare = migrate })
end

local function reconnect(done)
    require("agentic.acp.agent_instance").get_instance("agency", function(client)
        client:when_ready(function() done() end)
    end)
end

function M.describe(summary)
    local text = summary.rebound .. " session" .. (summary.rebound == 1 and "" or "s") .. " rebound"
    if #summary.stopped > 0 then text = text .. ", " .. #summary.stopped .. (#summary.stopped == 1 and " session's agent is" or " sessions' agents are") .. " stopped; reopen with <leader>ar" end
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
        if view.record.version == 3 and view.live and view.record.phase == "ready" and tuple(view) then ready[view.record.definition.agentId] = view end
    end
    local summary, settled = { rebound = 0, stopped = {}, missing = {}, failed = {}, timed_out = false }, false
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
        local Registry = require("agentic.session_registry")
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
            summary.failed[#summary.failed + 1] = { agentId = agent_id, error = type(err) == "table" and M.reason(err) or tostring(err) }
        end
        local function settle(token, err)
            local agent_id = loading[token]
            if agent_id == nil then return end
            loading[token] = nil
            if err then failed(agent_id, err) else summary.rebound = summary.rebound + 1 end
            finish()
        end
        for _, manager in ipairs(listed and managers or {}) do
            local agent_id = manager.session_id:sub(8)
            local view = ready[agent_id]
            if not view then
                local list = known[agent_id] and summary.stopped or summary.missing
                list[#list + 1] = agent_id
            elseif not M.dead(manager, tuple(view)) then
                summary.rebound = summary.rebound + 1
            else
                local token = {}
                loading[token] = agent_id
                local ok, target = pcall(M.reattach, manager, view)
                if not ok or not target then
                    loading[token] = nil
                    failed(agent_id, ok and "the session could not be reattached" or target)
                else
                    target:on_session_ready(function()
                        settle(token, Registry.get(target.session_key) ~= target and "the session closed before it reattached" or nil)
                    end, function() settle(token, target._agency_start_error or "the session did not start") end)
                end
            end
        end
        load_timer:start(opts.load_timeout_ms or 30000, 0, vim.schedule_wrap(function()
            for _, agent_id in pairs(loading) do failed(agent_id, "the session load did not finish") end
            loading = {}
            finish()
        end))
        opened = true
        finish()
    end))
end

return M