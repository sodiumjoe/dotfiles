local ACPClient = require("agentic.acp.acp_client")
local Client = setmetatable({}, { __index = ACPClient })
Client.__index = Client

local Stream = require("sodium.agency.stream")
local starting, immediate, submitting, cancelling

local Logger = require("agentic.utils.logger")
local notify = rawget(Logger, "_agency_notify") or Logger.notify
rawset(Logger, "_agency_notify", notify)
Logger.notify = function(message, ...)
    if type(message) == "string" and message:find("Agency Handler connection ended", 1, true) then
        return
    end
    return notify(message, ...)
end

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

local function failed(what, err)
    require("agentic.utils.logger").notify("Failed to " .. what .. ": " .. tostring(err))
end

local function prepare(client, id, request, handlers, manager)
    if manager._destroyed or client.subscribers[request.sessionId] ~= handlers then
        return "cancel"
    end
    if manager._agency_binding == nil then
        manager._agency_held_permissions = manager._agency_held_permissions or {}
        table.insert(manager._agency_held_permissions, { client = client, id = id, request = request, handlers = handlers })
        return "held"
    end
    Stream.flush(manager)
    local meta = type(request._meta) == "table" and request._meta.agency
    if type(meta) ~= "table" or not vim.deep_equal(meta.binding, manager._agency_binding) then
        return "cancel"
    end
    manager._agency_permissions = manager._agency_permissions or {}
    manager._agency_permissions[request.toolCall.toolCallId] = id
    return "offer"
end

local function offer(client, id, request, handlers, manager)
    local ok, verdict = pcall(prepare, client, id, request, handlers, manager)
    if not ok then
        failed("dispatch Agency session/request_permission", verdict)
        verdict = "cancel"
    end
    if verdict == "cancel" then
        local sent, err = pcall(client.__send_result, client, id, cancelled())
        if not sent then
            failed("answer Agency session/request_permission", err)
        end
    elseif verdict == "offer" then
        local delivered, err = deliver_now(handlers, function()
            ACPClient.__handle_request_permission(client, id, request)
        end)
        if not delivered then
            failed("dispatch Agency session/request_permission", err)
        end
    end
end

local function settle_held(manager, cancel)
    local held = manager._agency_held_permissions
    manager._agency_held_permissions = nil
    for _, entry in ipairs(held or {}) do
        if cancel then
            pcall(entry.client.__send_result, entry.client, entry.id, cancelled())
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

local function configure(manager, snapshot)
    local options = manager.config_options
    options:set_options(snapshot.configOptions or {})
    if type(snapshot.models) == "table" then
        options:set_legacy_models(snapshot.models)
    end
    if type(snapshot.modes) == "table" then
        options:set_legacy_modes(snapshot.modes)
    end
    require("agentic.acp.slash_commands").setCommands(manager.widget.buf_nrs.input, snapshot.availableCommands or {})
    manager.widget:schedule_header_refresh()
end

local function capture_submissions(manager)
    local widget = manager.widget
    if manager._agency_submit_widget == widget then
        return
    end
    manager._agency_submit_widget = widget
    local original = widget.on_submit_input
    widget.on_submit_input = function(text)
        local flushed, failure = pcall(Stream.flush, manager)
        if not flushed then
            failed("flush Agency streamed text", failure)
        end
        manager._agency_submit_snapshot = {
            input = text,
            selections = manager.code_selection:get_selections(),
            files = manager.file_list:get_files(),
            diagnostics = manager.diagnostics_list:get_diagnostics(),
            first = manager._is_first_message,
        }
        local ok, result = pcall(original, text)
        manager._agency_submit_snapshot = nil
        if not ok then
            error(result, 0)
        end
        return result
    end
end

local function adopt(manager, info, response)
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
    capture_submissions(manager)
    configure(manager, type(info.configuration) == "table" and info.configuration or response)
end

local function apply_attachment(manager, info, response)
    if manager._destroyed or not manager.session_id then
        return settle_held(manager, true)
    end
    if manager._agency_attachment ~= info then
        return
    end
    local ok, err = pcall(adopt, manager, info, response)
    settle_held(manager, manager._agency_binding == nil)
    if not ok then
        error(err)
    end
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
        if manager and err then
            manager._agency_start_error = err
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

local function caller(client, id)
    for _, session in pairs(require("agentic.session_registry").sessions) do
        if session.agent == client and session.session_id == id and not session._destroyed then
            return session
        end
    end
end

local function mark_unavailable(manager)
    manager._agency_unavailable = true
    manager._agency_binding, manager._agency_admissions, manager._agency_running = nil, {}, false
    manager._agency_held_permissions = nil
    for _, entry in ipairs(manager._agency_pending_context or {}) do
        entry.submission = nil
    end
end

local function show_unavailable(manager)
    if manager._destroyed then
        return
    end
    Stream.flush(manager)
    manager.permission_manager:clear()
    manager.status_animation:stop()
    manager.is_generating = false
end

local function restore_draft(manager, draft)
    local buffer = manager.widget.buf_nrs.input
    if type(draft.input) == "string" and vim.api.nvim_buf_is_valid(buffer)
        and table.concat(vim.api.nvim_buf_get_lines(buffer, 0, -1, false), "\n") == "" then
        vim.api.nvim_buf_set_lines(buffer, 0, -1, false, vim.split(draft.input, "\n", { plain = true }))
    end
    local present = manager.code_selection:get_selections()
    for _, selection in ipairs(draft.selections) do
        local found = false
        for _, existing in ipairs(present) do
            if vim.deep_equal(existing, selection) then
                found = true
                break
            end
        end
        if not found then
            manager.code_selection:add(selection)
        end
    end
    for _, file in ipairs(draft.files) do
        manager.file_list:add(file)
    end
    manager.diagnostics_list:add_many(draft.diagnostics)
end

local function settle_prompt(manager, submission, admission, err)
    if manager._agency_admissions then
        manager._agency_admissions[submission] = nil
    end
    local flushed, failure = pcall(Stream.flush, manager)
    if not flushed then
        failed("flush Agency streamed text", failure)
    end
    if not err or admission.accepted then
        return
    end
    for _, entry in ipairs(admission.entries) do
        entry.submission = nil
    end
    if manager._destroyed or manager._agency_unavailable and not admission.unavailable
        or not vim.deep_equal(manager._agency_binding, admission.binding) then
        return
    end
    for _, entry in ipairs(admission.entries) do
        if entry.rejected then
            entry.rejected(err)
        end
    end
    if admission.draft then
        restore_draft(manager, admission.draft)
        if manager._agency_local_submission == submission and admission.draft.first ~= nil then
            manager._is_first_message = admission.draft.first
        end
    end
    require("sodium.agency").setup().recover(manager)
end

local function recompute(manager)
    if manager._destroyed or manager._agency_unavailable then
        return
    end
    if manager._agency_running ~= nil then
        manager.is_generating = manager._agency_running or next(manager._agency_admissions or {}) ~= nil
    end
    if manager.is_generating then
        manager:_start_spinner("generating")
    end
end

local function withdraw(manager, params)
    local held = manager._agency_held_permissions or {}
    for index = #held, 1, -1 do
        if held[index].id == params.requestId and held[index].request.toolCall.toolCallId == params.toolCallId then
            table.remove(held, index)
        end
    end
    if manager._agency_permissions and manager._agency_permissions[params.toolCallId] == params.requestId then
        manager._agency_permissions[params.toolCallId] = nil
        manager.permission_manager:remove_request_by_tool_call_id(params.toolCallId)
    end
end

local function session_state(manager, params)
    if type(params.binding) ~= "table" then
        return
    end
    manager._agency_binding = vim.deepcopy(params.binding)
    settle_held(manager)
    if type(params.turnId) == "string" then
        manager._agency_turn_id = params.turnId
    end
    local admitted = params.submissionId or params.turnId
    local admission = type(admitted) == "string" and manager._agency_admissions and manager._agency_admissions[admitted]
    local running = params.submissionState == "running" or params.submissionState == nil and params.state == "running"
    if admission and running and not admission.accepted then
        admission.accepted = true
        for _, entry in ipairs(admission.entries) do
            require("sodium.agency.context").unstage(manager, entry)
            if entry.accepted then
                entry.accepted(admitted)
            end
        end
    end
    if params.state == "idle" then
        Stream.flush(manager)
        manager.message_writer:finish_thinking()
    end
    if params.state == "unavailable" then
        mark_unavailable(manager)
        return show_unavailable(manager)
    end
    local ended = manager._agency_running and params.state == "idle"
    local foreign = ended and manager._agency_attention_turn ~= nil and manager._agency_attention_turn ~= manager._agency_local_submission
    if params.state == "running" and type(params.turnId) == "string" then
        manager._agency_attention_turn = params.turnId
    end
    manager._agency_running = params.state == "running"
    if ended then
        manager._agency_attention_turn = nil
    end
    if foreign then
        require("agentic.utils.hooks").invoke("on_response_complete",
            { session_id = manager.session_id, session_key = manager.session_key, success = true })
    end
    manager.is_generating = manager._agency_running or next(manager._agency_admissions or {}) ~= nil
    if type(params.configuration) == "table" then
        configure(manager, params.configuration)
    end
    if manager.is_generating then
        manager:_start_spinner("generating")
    else
        manager.status_animation:stop()
    end
end

function Client:__request_params(method, params, context)
    if method == "session/prompt" and submitting then
        params._meta = { agency = { version = 1, submissionId = submitting, editor = vim.v.servername } }
        return params
    end
    if method == "session/cancel" and cancelling then
        params._meta = { agency = { version = 1, turnId = cancelling } }
        return params
    end
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
        local flushed, err = pcall(function()
            if manager then
                Stream.flush(manager)
            end
        end)
        if not flushed then
            failed("flush Agency streamed text", err)
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

function Client:send_prompt(id, prompt, callback)
    local manager = caller(self, id)
    if not manager then
        return ACPClient.send_prompt(self, id, prompt, callback)
    end
    local draft = manager._agency_submit_snapshot
    manager._agency_submit_snapshot = nil
    local submission = require("sodium.agency.control").uuid()
    manager._agency_local_submission, manager._agency_turn_id = submission, submission
    local staged = {}
    for _, entry in ipairs(manager._agency_pending_context or {}) do
        if not entry.submission then
            entry.submission = submission
            staged[#staged + 1] = entry
            vim.list_extend(prompt, vim.deepcopy(entry.content))
        end
    end
    local admission = { accepted = false, entries = staged, draft = draft, binding = vim.deepcopy(manager._agency_binding),
        unavailable = manager._agency_unavailable == true }
    manager._agency_admissions = manager._agency_admissions or {}
    manager._agency_admissions[submission] = admission
    local function reply(result, err)
        if manager._agency_unavailable and not admission.unavailable then
            vim.schedule(function()
                manager.is_generating = false
            end)
            return
        end
        vim.schedule(function()
            settle_prompt(manager, submission, admission, err)
        end)
        callback(result, err)
        vim.schedule(function()
            recompute(manager)
        end)
    end
    submitting = submission
    local ok, failure = pcall(ACPClient.send_prompt, self, id, prompt, reply)
    submitting = nil
    if not ok then
        error(failure, 0)
    end
end

function Client:stop_generation(id)
    local manager = caller(self, id)
    if not manager then
        return ACPClient.stop_generation(self, id)
    end
    local flushed, failure = pcall(Stream.flush, manager)
    if not flushed then
        failed("flush Agency streamed text", failure)
    end
    if not manager._agency_turn_id then
        return
    end
    cancelling = manager._agency_turn_id
    local ok, err = pcall(ACPClient.stop_generation, self, id)
    cancelling = nil
    if not ok then
        error(err, 0)
    end
end

function Client:__handle_unknown_method(id, method, params)
    if id ~= nil or method ~= "agency/session_state" and method ~= "agency/permission_withdrawn"
        or type(params) ~= "table" or type(params.sessionId) ~= "string" then
        return ACPClient.__handle_unknown_method(self, id, method, params)
    end
    local handlers = self.subscribers[params.sessionId]
    if handlers then
        handlers._agency_replay_batch = nil
    end
    vim.schedule(function()
        local manager = require("agentic.session_registry").find_by_acp_session_id(params.sessionId, self)
        if not manager or manager._destroyed or manager._agency_unavailable
            or manager._agency_binding and not vim.deep_equal(manager._agency_binding, params.binding) then
            return
        end
        if method == "agency/permission_withdrawn" then
            withdraw(manager, params)
        else
            session_state(manager, params)
        end
    end)
end

function Client:__on_state_change(old, new)
    if old ~= "ready" or new ~= "error" and new ~= "disconnected" then
        return
    end
    if type(self.transport) ~= "table" or self.transport.process == nil then
        return
    end
    local managers = {}
    for _, session in pairs(require("agentic.session_registry").sessions) do
        if session.agent == self and not session._destroyed then
            mark_unavailable(session)
            managers[#managers + 1] = session
        end
    end
    vim.schedule(function()
        for _, manager in ipairs(managers) do
            local ok, err = pcall(show_unavailable, manager)
            if not ok then
                failed("mark the Agency session unavailable", err)
            end
        end
        if not vim.g.agency_reload_running then
            local ok, err = pcall(function()
                require("sodium.agency").setup().resume()
            end)
            if not ok then
                failed("reconnect Agency sessions", err)
            end
        end
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