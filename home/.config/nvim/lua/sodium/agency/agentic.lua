local M = {}
local installed = false

local function agency(client)
    return client and client.provider_config == require("agentic.config").acp_providers.agency
end

local function token(manager, binding, turn)
    return { epoch = manager._agency_epoch, binding = vim.deepcopy(manager._agency_binding),
        turn_id = manager._agency_turn_id, check_binding = binding, check_turn = turn }
end

function M.guard_callback(manager, captured, callback)
    return function(...)
        if manager._agency_destroyed or manager._agency_epoch ~= captured.epoch
            or captured.check_binding and not vim.deep_equal(manager._agency_binding, captured.binding)
            or captured.check_turn and manager._agency_turn_id ~= captured.turn_id then return end
        return callback(...)
    end
end

local function invoke(manager, captured, callback, ...)
    local schedule, args = vim.schedule, { n = select("#", ...), ... }
    vim.schedule = function(fn)
        schedule(M.guard_callback(manager, captured, function()
            fn()
            if manager.is_generating then manager:_start_spinner("generating") end
        end))
    end
    local ok, result = xpcall(function() return callback(unpack(args, 1, args.n)) end, debug.traceback)
    vim.schedule = schedule
    if not ok then error(result) end
    return result
end

local function lifecycle(manager, callback, ...)
    local depth = manager._agency_depth or 0
    if depth == 0 then
        manager._agency_epoch = (manager._agency_epoch or 0) + 1
        manager._agency_binding, manager._agency_turn_id = nil, nil
        manager._agency_local_submission, manager._agency_permissions = nil, {}
    end
    manager._agency_depth = depth + 1
    local args = { n = select("#", ...), ... }
    local ok, result = xpcall(function() return callback(manager, unpack(args, 1, args.n)) end, debug.traceback)
    manager._agency_depth = depth
    if not ok then error(result) end
    return result
end

function M.apply_configuration(options, snapshot)
    options:set_options(snapshot.configOptions or {})
    if type(snapshot.models) == "table" then options:set_legacy_models(snapshot.models) end
    if type(snapshot.modes) == "table" then options:set_legacy_modes(snapshot.modes) end
end

local function configuration(manager, snapshot)
    M.apply_configuration(manager.config_options, snapshot)
    require("agentic.acp.slash_commands").setCommands(manager.widget.buf_nrs.input, snapshot.availableCommands or {})
    manager.widget:schedule_header_refresh()
end

local function attachment(manager, result)
    local info = result and result._meta and result._meta.agency
    assert(type(info) == "table" and info.version == 1 and type(info.binding) == "table", "Agency attachment metadata missing")
    manager._agency_binding = vim.deepcopy(info.binding)
    manager._agency_backend_id = info.backendId
    manager._agency_capabilities = info.capabilities
    manager.session_state._provider_name = info.backendId
    manager.message_writer:set_provider_name(info.backendId)
    configuration(manager, info.configuration)
    if type(info.turnId) == "string" and manager._agency_turn_id == nil then manager._agency_turn_id = info.turnId end
    manager.history_to_send = nil
end

function M.install()
    local provider = require("agentic.config").acp_providers.agency
    if provider and not provider.name then provider.name = "Agency" end
    if installed then return end
    local Manager = require("agentic.session_manager")
    local Client = require("agentic.acp.acp_client")
    local Instances = require("agentic.acp.agent_instance")
    local methods = { { Manager, { "new", "new_session", "load_acp_session", "_cancel_session", "destroy", "_build_handlers", "_on_session_update", "_handle_input_submit" } },
        { Client, { "create_session", "load_session", "send_prompt", "cancel_session", "stop_generation", "__with_subscriber", "_handle_notification", "__handle_request_permission", "_send_request", "_send_notification", "_subscribe", "__send_result" } } }
    for _, entry in ipairs(methods) do
        for _, name in ipairs(entry[2]) do assert(type(entry[1][name]) == "function", "Unsupported Agentic API: " .. name) end
    end
    local native = {}
    for _, entry in ipairs(methods) do for _, name in ipairs(entry[2]) do native[entry[1]] = native[entry[1]] or {}; native[entry[1]][name] = entry[1][name] end end
    local sm, acp = native[Manager], native[Client]

    function Manager:new(tab)
        if require("agentic.config").provider ~= "agency" then return sm.new(self, tab) end
        local get, manager = Instances.get_instance, nil
        Instances.get_instance = function(provider, ready)
            return get(provider, function(client)
                local schedule = vim.schedule
                vim.schedule = function(fn)
                    schedule(function() if manager and not manager._agency_destroyed and manager._agency_epoch == 0 then fn() end end)
                end
                local ok, err = xpcall(function() ready(client) end, debug.traceback)
                vim.schedule = schedule
                if not ok then error(err) end
            end)
        end
        local ok, result = xpcall(function() return sm.new(self, tab) end, debug.traceback)
        Instances.get_instance = get
        if not ok then error(result) end
        manager = result
        if manager then manager._agency_epoch, manager._agency_permissions = 0, {} end
        return manager
    end

    function Manager:new_session(opts)
        if not agency(self.agent) then return sm.new_session(self, opts) end
        if self._agency_destroyed then return end
        local intent = self._agency_intent
        self._agency_intent = nil
        if intent and intent.session_id then
            self._agency_load_cwd = intent.cwd
            return self:load_acp_session(intent.session_id, intent.title, intent.timestamp)
        end
        local previous = self.session_id
        self._agency_new_options = intent or { inherit_session_id = previous }
        return lifecycle(self, sm.new_session, opts)
    end

    function Manager:load_acp_session(...)
        if not agency(self.agent) then return sm.load_acp_session(self, ...) end
        local restore = self.config_options.restore_snapshot
        self.config_options.restore_snapshot = function() end
        self._agency_loading_session = select(1, ...)
        local args = { n = select("#", ...), ... }
        local ok, result = xpcall(function() return lifecycle(self, sm.load_acp_session, unpack(args, 1, args.n)) end, debug.traceback)
        self.config_options.restore_snapshot = restore
        if not ok then error(result) end
        return result
    end

    for _, name in ipairs({ "_cancel_session", "destroy" }) do
        Manager[name] = function(self, ...)
            if not agency(self.agent) then return sm[name](self, ...) end
            if name == "_cancel_session" and self.session_id == nil and self._agency_loading_session then
                local handlers = self.agent.subscribers[self._agency_loading_session]
                if handlers and handlers._agency_owner == self then self.agent:cancel_session(self._agency_loading_session) end
            end
            local result = lifecycle(self, sm[name], ...)
            if name == "destroy" then self._agency_destroyed = true end
            return result
        end
    end

    function Manager:_build_handlers()
        local handlers = sm._build_handlers(self)
        if agency(self.agent) then handlers._agency_owner, handlers._agency_epoch = self, self._agency_epoch end
        return handlers
    end

    function Manager:_on_session_update(update)
        if not agency(self.agent) or update.sessionUpdate ~= "user_message_chunk" then return sm._on_session_update(self, update) end
        local restoring = self._is_restoring_session
        self._is_restoring_session = true
        local result = sm._on_session_update(self, update)
        self._is_restoring_session = restoring
        return result
    end

    function Manager:_handle_input_submit(input)
        if not agency(self.agent) then return sm._handle_input_submit(self, input) end
        self.history_to_send = nil
        self._agency_input = input
        self._agency_captured_context = { selections = self.code_selection:get_selections(),
            files = self.file_list:get_files(), diagnostics = self.diagnostics_list:get_diagnostics(), first = self._is_first_message }
        return sm._handle_input_submit(self, input)
    end

    function Client:create_session(handlers, callback)
        if not agency(self) then return acp.create_session(self, handlers, callback) end
        local manager, captured = handlers._agency_owner, { epoch = handlers._agency_epoch }
        local opts = manager._agency_new_options or {}
        manager._agency_initial_context = opts.initial_context
        local environment = vim.fn.environ()
        environment.NVIM = vim.v.servername
        local meta = { version = 1, commandId = require("sodium.agency.control").uuid(), environment = environment,
            backendId = opts.backend_id, selection = opts.selection, inheritSessionId = opts.inherit_session_id }
        self:_send_request("session/new", { cwd = opts.cwd or vim.fn.getcwd(), mcpServers = opts.mcp_servers or {}, _meta = { agency = meta } },
            M.guard_callback(manager, captured, function(result, err)
                if manager._agency_deferred_detach then
                    local previous = manager._agency_deferred_detach
                    manager._agency_deferred_detach = nil
                    if not result or result.sessionId ~= previous then self:_send_notification("agency/detach", { sessionId = previous }) end
                end
                if result and not err then
                    attachment(manager, result)
                    self:_subscribe(result.sessionId, handlers)
                end
                local next_token = token(manager, true, false)
                invoke(manager, next_token, callback, result, err)
                if result and not err then configuration(manager, result._meta.agency.configuration) end
            end))
    end

    function Client:_send_request(method, params, callback)
        if agency(self) and method:match("^session/set_") then
            local handlers = self.subscribers[params.sessionId]
            if handlers then
                local manager, original = handlers._agency_owner, callback
                local captured = token(manager, true, false)
                callback = M.guard_callback(manager, captured, function(...) return invoke(manager, captured, original, ...) end)
            end
        end
        return acp._send_request(self, method, params, callback)
    end

    function Client:load_session(id, cwd, servers, handlers, callback)
        if not agency(self) then return acp.load_session(self, id, cwd, servers, handlers, callback) end
        local manager, captured = handlers._agency_owner, { epoch = handlers._agency_epoch }
        self:_subscribe(id, handlers)
        self:_send_request("session/load", { sessionId = id, cwd = manager._agency_load_cwd or cwd, mcpServers = servers or {} },
            M.guard_callback(manager, captured, function(result, err)
                if err then if self.subscribers[id] == handlers then self.subscribers[id] = nil end
                else attachment(manager, result) end
                invoke(manager, token(manager, true, false), function()
                    callback(err)
                    vim.schedule(function()
                        if not err then
                            manager._agency_loading_session = nil
                            for _, ready in ipairs(manager._session_ready_callbacks) do ready() end
                            manager._session_ready_callbacks = {}
                        end
                    end)
                end)
            end))
    end

    function Client:__with_subscriber(id, callback)
        if not agency(self) then return acp.__with_subscriber(self, id, callback) end
        local handlers = self.subscribers[id]
        if not handlers then return end
        local manager = handlers._agency_owner
        vim.schedule(M.guard_callback(manager, { epoch = handlers._agency_epoch }, function()
            if self.subscribers[id] == handlers then callback(handlers) end
        end))
    end

    function Client:send_prompt(id, prompt, callback)
        if not agency(self) then return acp.send_prompt(self, id, prompt, callback) end
        local manager = assert(self.subscribers[id])._agency_owner
        local submission = require("sodium.agency.control").uuid()
        manager._agency_local_submission, manager._agency_turn_id = submission, submission
        local captured, input = token(manager, true, true), manager._agency_input
        local context = manager._agency_captured_context
        local initial = manager._agency_initial_context
        if initial then vim.list_extend(prompt, vim.deepcopy(initial)) end
        local admission = { accepted = false }
        manager._agency_admission = admission
        self:_send_request("session/prompt", { sessionId = id, prompt = prompt, _meta = { agency = { version = 1, submissionId = submission } } }, function(result, err)
            if err and not admission.accepted then
                M.guard_callback(manager, token(manager, false, false), function()
                    if manager._agency_epoch ~= captured.epoch or not vim.deep_equal(manager._agency_binding, captured.binding) then return end
                    local buffer = manager.widget.buf_nrs.input
                    if vim.api.nvim_buf_is_valid(buffer) and table.concat(vim.api.nvim_buf_get_lines(buffer, 0, -1, false), "\n") == "" then
                        vim.api.nvim_buf_set_lines(buffer, 0, -1, false, vim.split(input or "", "\n", { plain = true }))
                    end
                    if context then
                        for _, selection in ipairs(context.selections) do
                            local found = false
                            for _, existing in ipairs(manager.code_selection:get_selections()) do if vim.deep_equal(existing, selection) then found = true; break end end
                            if not found then manager.code_selection:add(selection) end
                        end
                        for _, file in ipairs(context.files) do manager.file_list:add(file) end
                        manager.diagnostics_list:add_many(context.diagnostics)
                        manager._is_first_message = context.first
                    end
                end)()
            end
            M.guard_callback(manager, captured, function() invoke(manager, captured, callback, result, err) end)()
        end)
    end

    function Client:cancel_session(id)
        if not agency(self) then return acp.cancel_session(self, id) end
        if not id then return end
        local handlers = self.subscribers[id]
        self.subscribers[id] = nil
        if handlers and handlers._agency_owner._agency_new_options
            and handlers._agency_owner._agency_new_options.inherit_session_id == id then
            handlers._agency_owner._agency_deferred_detach = id
            return
        end
        self:_send_notification("agency/detach", { sessionId = id })
    end

    function Client:stop_generation(id)
        if not agency(self) then return acp.stop_generation(self, id) end
        local handlers = self.subscribers[id]
        if not handlers or not handlers._agency_owner._agency_turn_id then return end
        self:_send_notification("session/cancel", { sessionId = id, _meta = { agency = { version = 1, turnId = handlers._agency_owner._agency_turn_id } } })
    end

    function Client:__handle_request_permission(request_id, request)
        if not agency(self) then return acp.__handle_request_permission(self, request_id, request) end
        self:__with_subscriber(request.sessionId, function(handlers)
            local manager, tool = handlers._agency_owner, request.toolCall.toolCallId
            local meta = request._meta and request._meta.agency
            if not meta or not vim.deep_equal(manager._agency_binding, meta.binding) then return end
            manager._agency_permissions[tool] = request_id
            handlers.on_tool_call_update(self:__build_tool_call_message(request.toolCall))
            handlers.on_request_permission(request, M.guard_callback(manager, token(manager, true, false), function(option)
                if manager._agency_permissions[tool] ~= request_id then return end
                manager._agency_permissions[tool] = nil
                self:__send_result(request_id, { outcome = option and { outcome = "selected", optionId = option } or { outcome = "cancelled" } })
            end))
        end)
    end

    function Client:_handle_notification(request_id, method, params)
        if not agency(self) then return acp._handle_notification(self, request_id, method, params) end
        if method == "agency/session_state" or method == "agency/permission_withdrawn" then
            self:__with_subscriber(params.sessionId, function(handlers)
                local manager = handlers._agency_owner
                if manager._agency_binding and not vim.deep_equal(manager._agency_binding, params.binding) then return end
                if method == "agency/permission_withdrawn" then
                    if manager._agency_permissions[params.toolCallId] ~= params.requestId then return end
                    manager.permission_manager:remove_request_by_tool_call_id(params.toolCallId)
                else
                    manager._agency_binding = vim.deepcopy(params.binding)
                    if type(params.turnId) == "string" then manager._agency_turn_id = params.turnId end
                    if params.state == "running" and params.turnId == manager._agency_local_submission and manager._agency_admission then
                        manager._agency_admission.accepted = true
                        manager._agency_initial_context = nil
                    end
                    manager.is_generating = params.state == "running"
                    if params.state == "unavailable" then manager._agency_epoch = manager._agency_epoch + 1; manager.permission_manager:clear() end
                    if params.configuration then configuration(manager, params.configuration) end
                    if manager.is_generating then manager:_start_spinner("generating") else manager.status_animation:stop() end
                end
            end)
            return
        end
        if method == "session/update" and params.update and params.update.sessionUpdate == "user_message_chunk" then
            local handlers = self.subscribers[params.sessionId]
            local meta = params._meta and params._meta.agency
            if handlers and meta and type(meta.submissionId) == "string" and not meta.replay
                and meta.submissionId == handlers._agency_owner._agency_local_submission then return end
        end
        return acp._handle_notification(self, request_id, method, params)
    end
    installed = true
end

function M.open(view)
    M.install()
    local record = assert(view.record)
    assert(record.version == 3, "Unavailable legacy Agency session")
    local id, Registry = "agency:" .. record.definition.agentId, require("agentic.session_registry")
    for tab, manager in pairs(Registry.sessions) do
        if agency(manager.agent) and (manager.session_id == id or manager._agency_loading_session == id
            or manager._agency_intent and manager._agency_intent.session_id == id) and vim.api.nvim_tabpage_is_valid(tab) then
            vim.api.nvim_set_current_tabpage(tab)
            manager.widget:show()
            return manager
        end
    end
    local tab = vim.api.nvim_get_current_tabpage()
    if Registry.sessions[tab] then vim.cmd("tabnew"); tab = vim.api.nvim_get_current_tabpage() end
    local manager = assert(Registry.get_session_for_tab_page(tab))
    manager._agency_intent = { session_id = id, cwd = record.definition.cwd, title = record.definition.backendId }
    manager.widget:show()
    return manager
end

function M.new_session(opts)
    M.install()
    local Registry = require("agentic.session_registry")
    local tab = vim.api.nvim_get_current_tabpage()
    if Registry.sessions[tab] then vim.cmd("tabnew"); tab = vim.api.nvim_get_current_tabpage() end
    local manager = assert(Registry.get_session_for_tab_page(tab))
    manager._agency_intent = opts or {}
    manager.widget:show()
    return manager
end

return M