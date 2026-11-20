local ACPClient = require("agentic.acp.acp_client")
local Client = setmetatable({}, { __index = ACPClient })
Client.__index = Client

local starting

local function manager_for(handlers)
    if handlers._agency_manager then
        return handlers._agency_manager
    end
    for _, session in pairs(require("agentic.session_registry").sessions) do
        if session.handlers == handlers then
            return session
        end
    end
end

local function apply_attachment(manager, info, response)
    if manager._destroyed or not manager.session_id or manager._agency_attachment ~= info then
        return
    end
    manager._agency_binding = vim.deepcopy(info.binding)
    manager._agency_cwd = manager._agency_request_cwd
    manager.session_state._provider_name = info.backendId
    manager.message_writer:set_provider_name(info.backendId)
    if info.historyTruncated then
        manager.message_writer:write_structural_message(
            require("agentic.acp.acp_payloads").generate_agent_message({ "Agency retained display history is truncated." })
        )
    end
    if type(info.turnId) == "string" and manager._agency_turn_id == nil then
        manager._agency_turn_id = info.turnId
    end
    manager.history_to_send = nil
    local snapshot = type(info.configuration) == "table" and info.configuration or response
    require("sodium.agency.agentic").apply_configuration(manager.config_options, snapshot)
    require("agentic.acp.slash_commands").setCommands(manager.widget.buf_nrs.input, snapshot.availableCommands or {})
    manager.widget:schedule_header_refresh()
end

local function start(handlers, flag, cwd, send, callback)
    local manager, pending = manager_for(handlers), {}
    if manager then
        handlers._agency_manager, manager[flag], manager._agency_request_cwd = manager, pending, cwd
    end
    send(function(result, err)
        if manager and manager[flag] == pending then
            manager[flag] = nil
        end
        local info = not err and result and result._meta and result._meta.agency
        local attach = manager and not manager._destroyed and type(info) == "table" and type(info.binding) == "table"
        if attach then
            manager._agency_attachment = info
        end
        if callback then
            callback(result, err)
        end
        if attach then
            vim.schedule(function()
                apply_attachment(manager, info, result)
            end)
        end
    end)
end

function Client:__request_params(method, params, context)
    if method ~= "session/new" and method ~= "session/load" then
        return params
    end
    if method == "session/new" and starting then
        starting._agency_request_cwd = params.cwd
    end
    local agency = { version = 1, editor = vim.v.servername }
    if method == "session/new" then
        local spec = type(context) == "table" and context or {}
        local meta = spec.meta or {}
        local environment = vim.tbl_extend("force", vim.fn.environ(), meta.environment or {})
        environment.NVIM = vim.v.servername
        agency.environment, agency.backendId, agency.selection = environment, meta.backend_id, meta.selection
        if spec.source_session_id and not meta.backend_id then
            agency.inheritSessionId = spec.source_session_id
        end
    end
    params._meta = { agency = agency }
    return params
end

function Client:create_session(handlers, callback, cwd_callback, spec)
    start(handlers, "_agency_new_pending", nil, function(reply)
        starting = handlers._agency_manager
        ACPClient.create_session(self, handlers, reply, cwd_callback, spec)
        starting = nil
    end, callback)
end

function Client:load_session(id, cwd, servers, handlers, callback, spec)
    start(handlers, "_agency_load_pending", cwd, function(reply)
        ACPClient.load_session(self, id, cwd, servers, handlers, reply, spec)
    end, callback)
end

function Client:cancel_session(id, handlers)
    if not id or handlers and self.subscribers[id] ~= handlers then
        return
    end
    local owner = handlers or self.subscribers[id]
    self.subscribers[id] = nil
    local manager = owner and manager_for(owner)
    if manager and manager._agency_routed_permissions then
        manager._agency_routed_permissions.close()
        manager._agency_routed_permissions = nil
    end
    self:_send_notification("agency/detach", { sessionId = id })
end

function Client:new(config, on_ready)
    return ACPClient.new(self, config, on_ready)
end

function Client:request(method, params, callback)
    return self:_send_request(method, params, callback)
end

function Client:request_with_timeout(method, params, timeout_ms, callback)
    local settled, timer, ready, response = false, assert(vim.uv.new_timer()), nil, nil
    local function cleanup()
        timer:stop()
        timer:close()
        for index, listener in ipairs(self.ready_listeners) do
            if listener.on_ready == ready then
                table.remove(self.ready_listeners, index)
                break
            end
        end
        for id, pending in pairs(self.callbacks) do
            if pending == response then
                self.callbacks[id] = function() end
                break
            end
        end
    end
    local function finish(result, err)
        if settled then
            return
        end
        settled = true
        cleanup()
        vim.schedule(function()
            callback(result, err)
        end)
    end
    timer:start(timeout_ms, 0, function()
        finish(nil, self:__create_error(self.ERROR_CODES.TIMEOUT_ERROR, method .. " timed out"))
    end)
    ready = function()
        if settled then
            return
        end
        response = function(result, err)
            finish(result, err)
        end
        local sent, failure = pcall(self._send_request, self, method, params, response)
        if not sent then
            finish(nil, self:__create_error(self.ERROR_CODES.TRANSPORT_ERROR, tostring(failure)))
        end
    end
    self:when_ready(ready, function(err)
        finish(nil, err)
    end)
    return function()
        if not settled then
            settled = true
            cleanup()
        end
    end
end

return Client