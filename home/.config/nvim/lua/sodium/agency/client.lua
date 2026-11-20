local ACPClient = require("agentic.acp.acp_client")
local Client = setmetatable({}, { __index = ACPClient })
Client.__index = Client

local Stream = require("sodium.agency.stream")
local starting, immediate

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

local function cancelled()
    return { outcome = { outcome = "cancelled" } }
end

local function deliver_now(handlers, fn)
    local previous = immediate
    immediate = handlers
    local ok, err = pcall(fn)
    immediate = previous
    return ok, err
end

local function offer(client, id, request, handlers, manager)
    if manager._destroyed or client.subscribers[request.sessionId] ~= handlers then
        return client:__send_result(id, cancelled())
    end
    if manager._agency_binding == nil then
        manager._agency_held_permissions = manager._agency_held_permissions or {}
        table.insert(manager._agency_held_permissions, { client = client, id = id, request = request, handlers = handlers })
        return
    end
    Stream.flush(manager)
    local meta = type(request._meta) == "table" and request._meta.agency
    if type(meta) ~= "table" or not vim.deep_equal(meta.binding, manager._agency_binding) then
        return client:__send_result(id, cancelled())
    end
    manager._agency_permissions = manager._agency_permissions or {}
    manager._agency_permissions[request.toolCall.toolCallId] = id
    local ok, err = deliver_now(handlers, function()
        ACPClient.__handle_request_permission(client, id, request)
    end)
    if not ok then
        error(err)
    end
end

local function settle_held(manager, cancel)
    local held = manager._agency_held_permissions
    manager._agency_held_permissions = nil
    for _, entry in ipairs(held or {}) do
        if cancel then
            entry.client:__send_result(entry.id, cancelled())
        else
            offer(entry.client, entry.id, entry.request, entry.handlers, manager)
        end
    end
end

local function replay(client, handlers, manager, params)
    local batch = handlers._agency_replay_batch
    if not batch then
        batch = {}
        handlers._agency_replay_batch = batch
        vim.schedule(function()
            if handlers._agency_replay_batch == batch then
                handlers._agency_replay_batch = nil
            end
            if manager._destroyed or client.subscribers[params.sessionId] ~= handlers then
                return
            end
            Stream.flush(manager)
            local writer = manager.message_writer
            local capture, apply = writer._capture_scroll, writer._apply_scroll
            local own_capture, own_apply = rawget(writer, "_capture_scroll"), rawget(writer, "_apply_scroll")
            capture(writer, writer.bufnr)
            writer._capture_scroll, writer._apply_scroll = function() end, function() end
            for _, entry in ipairs(batch) do
                if entry.fragments then
                    entry.params.update.content.text = table.concat(entry.fragments)
                end
                local ok, failure = deliver_now(handlers, function()
                    ACPClient.__handle_session_update(client, entry.params)
                end)
                if not ok then
                    vim.schedule(function()
                        error(failure)
                    end)
                end
            end
            writer._capture_scroll, writer._apply_scroll = own_capture, own_apply
            if not manager._destroyed then
                apply(writer, writer.bufnr)
            end
        end)
    end
    local update, previous = params.update, batch[#batch]
    local key = Stream.mergeable(update) and vim.tbl_extend("force", update, { content = false })
    if key and previous and previous.fragments and vim.deep_equal(previous.key, key) then
        previous.fragments[#previous.fragments + 1] = update.content.text
        return
    end
    local entry = { params = params }
    if key then
        entry.params = vim.tbl_extend("force", params, { update = vim.tbl_extend("force", update, { content = vim.deepcopy(update.content) }) })
        entry.fragments, entry.key = { update.content.text }, key
    end
    batch[#batch + 1] = entry
end

local function apply_attachment(manager, info, response)
    if manager._destroyed or not manager.session_id then
        return settle_held(manager, true)
    end
    if manager._agency_attachment ~= info then
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
    settle_held(manager)
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
        elseif manager then
            settle_held(manager, true)
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
    if manager then
        settle_held(manager, true)
    end
    self:_send_notification("agency/detach", { sessionId = id })
end

function Client:__handle_session_update(params)
    local update = type(params) == "table" and params.update
    local handlers = type(update) == "table" and type(params.sessionId) == "string" and self.subscribers[params.sessionId]
    local manager = handlers and manager_for(handlers)
    if not manager then
        return ACPClient.__handle_session_update(self, params)
    end
    local meta = type(params._meta) == "table" and type(params._meta.agency) == "table" and params._meta.agency or {}
    if meta.replay == true then
        return replay(self, handlers, manager, params)
    end
    handlers._agency_replay_batch = nil
    if update.sessionUpdate == "user_message_chunk" and type(meta.submissionId) == "string"
        and manager._agency_admissions and manager._agency_admissions[meta.submissionId] then
        return
    end
    if not Stream.mergeable(update) then
        return ACPClient.__handle_session_update(self, params)
    end
    local id = params.sessionId
    ACPClient.__with_subscriber(self, id, function(subscriber)
        if subscriber == handlers then
            Stream.update(manager, self, id, update, function()
                subscriber.on_session_update(update)
            end)
        end
    end)
end

function Client:__with_subscriber(id, callback, on_missing)
    local handlers = self.subscribers[id]
    local function deliver(subscriber)
        if subscriber ~= handlers then
            if on_missing then
                on_missing()
            end
            return
        end
        local manager = manager_for(subscriber)
        if manager then
            Stream.flush(manager)
        end
        callback(subscriber)
    end
    if handlers and immediate == handlers and not vim.in_fast_event() then
        return deliver(handlers)
    end
    return ACPClient.__with_subscriber(self, id, deliver, on_missing)
end

function Client:__handle_request_permission(id, request)
    local valid = type(request) == "table" and type(request.sessionId) == "string" and type(request.toolCall) == "table"
    local handlers = valid and self.subscribers[request.sessionId]
    local manager = handlers and manager_for(handlers)
    if not manager then
        return ACPClient.__handle_request_permission(self, id, request)
    end
    handlers._agency_replay_batch = nil
    vim.schedule(function()
        offer(self, id, request, handlers, manager)
    end)
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