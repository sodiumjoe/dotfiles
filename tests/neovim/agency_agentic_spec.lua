local Config = require("agentic.config")
local ACPClient = require("agentic.acp.acp_client")
local Registry = require("agentic.session_registry")
local Instances = require("agentic.acp.agent_instance")
local logical = "agency:11111111-1111-4111-8111-111111111111"
local binding = { agentId = logical:sub(8), handlerGeneration = "22222222-2222-4222-8222-222222222222", providerGeneration = "33333333-3333-4333-8333-333333333333" }

local function flush()
    vim.wait(30, function() return false end)
end

describe("native Agency Agentic adaptation", function()
    local original_provider, original_agency, original_instances, client, frames, integration
    before_each(function()
        original_provider, original_agency, original_instances = Config.provider, Config.acp_providers.agency, Instances._instances
        Config.provider = "agency"
        Config.acp_providers.agency = { name = "Agency", command = vim.v.progpath, args = {} }
        frames = {}
        client = setmetatable({ provider_config = Config.acp_providers.agency, state = "ready", id_counter = 0,
            callbacks = {}, subscribers = {}, ready_listeners = {}, agent_capabilities = { loadSession = true },
            transport = { send = function(_, data) frames[#frames + 1] = vim.json.decode(data) end } }, ACPClient)
        Instances._instances = { agency = client }
        integration = require("sodium.agency.agentic")
        integration.install()
    end)
    after_each(function()
        for tab in pairs(Registry.sessions) do Registry.destroy_session(tab) end
        flush()
        Config.provider, Config.acp_providers.agency, Instances._instances = original_provider, original_agency, original_instances
    end)

    local function request(method)
        for index = #frames, 1, -1 do if frames[index].method == method then return frames[index] end end
        error("missing request " .. method)
    end
    local function reply(frame, backend, snapshot, target)
        client:_handle_message({ id = frame.id, result = { sessionId = logical, _meta = { agency = {
            version = 1, binding = target or binding, backendId = backend or "codex-acp", turnId = vim.NIL,
            configuration = snapshot or { configOptions = {}, models = vim.NIL, modes = vim.NIL, availableCommands = {} },
        } } } })
    end
    local function opened()
        local manager = integration.open({ record = { version = 3, definition = { agentId = binding.agentId, cwd = vim.fn.getcwd(), backendId = "codex-acp" }, launch = binding }, live = true })
        flush()
        if manager.session_id ~= logical then reply(request("session/load")); flush() end
        manager._is_first_message = false
        return manager
    end
    local function state(manager, turn, status, target)
        client:_handle_message({ method = "agency/session_state", params = { sessionId = logical, binding = target or binding, turnId = turn or vim.NIL, state = status } })
        flush()
    end

    it("clears configuration from another backend before applying an empty snapshot", function()
        local co = require("agentic.acp.agent_config_options"):new({}, {})
        co:set_legacy_modes({ currentModeId = "old", availableModes = { { id = "old", name = "Old" } } })
        co:set_legacy_models({ currentModelId = "old-model", availableModels = { { modelId = "old-model", name = "Old" } } })
        integration.apply_configuration(co, { configOptions = {}, models = vim.NIL, modes = vim.NIL })
        assert.is_nil(co:get_mode_id())
        assert.is_nil(co:get_model_id())
    end)

    it("loads through the actual constructor without creating a temporary conversation", function()
        local manager = opened()
        assert.are.equal(logical, manager.session_id)
        for _, frame in ipairs(frames) do assert.is_not.equal("session/new", frame.method) end
        assert.are.equal(require("agentic.session_manager"), getmetatable(manager))
        assert.are.equal(manager, integration.open({ record = { version = 3, definition = { agentId = binding.agentId, cwd = vim.fn.getcwd() } }, live = true }))
    end)

    it("destroys the native view by detaching without canceling the shared turn", function()
        local manager = opened()
        state(manager, "turn-a", "running")
        manager:destroy()
        assert.are.equal(logical, request("agency/detach").params.sessionId)
        for _, frame in ipairs(frames) do assert.is_not.equal("session/cancel", frame.method) end
    end)

    it("detaches an in-flight load when its view is destroyed", function()
        local manager = integration.open({ record = { version = 3, definition = { agentId = binding.agentId, cwd = vim.fn.getcwd() } }, live = true })
        flush()
        assert.is_nil(manager.session_id)
        manager:destroy()
        assert.is_nil(client.subscribers[logical])
        assert.are.equal(logical, request("agency/detach").params.sessionId)
    end)

    it("guards a queued native finish after reload before it clears the replacement turn", function()
        local manager = opened()
        manager:_handle_input_submit("old")
        local old = request("session/prompt")
        local original_schedule, queued = vim.schedule, {}
        vim.schedule = function(fn) queued[#queued + 1] = fn end
        client:_handle_message({ id = old.id, result = { stopReason = "end_turn" } })
        vim.schedule = original_schedule
        manager:load_acp_session(logical)
        reply(request("session/load"))
        flush()
        manager:_handle_input_submit("new")
        local current = request("session/prompt")
        state(manager, current.params._meta.agency.submissionId, "running")
        local before = vim.api.nvim_buf_get_lines(manager.widget.buf_nrs.chat, 0, -1, false)
        for _, fn in ipairs(queued) do fn() end
        assert.is_true(manager.is_generating)
        assert.are.same(before, vim.api.nvim_buf_get_lines(manager.widget.buf_nrs.chat, 0, -1, false))
    end)

    it("pins explicit cancellation to the observed turn", function()
        local manager = opened()
        state(manager, "turn-a", "running")
        client:stop_generation(logical)
        assert.are.equal("turn-a", request("session/cancel").params._meta.agency.turnId)
    end)

    it("renders observer user chunks through native chat history", function()
        local manager = opened()
        client:_handle_message({ method = "session/update", params = { sessionId = logical, update = { sessionUpdate = "user_message_chunk", content = { type = "text", text = "observer input" } }, _meta = { agency = { replay = false } } } })
        flush()
        assert.are.equal("observer input", manager.chat_history.messages[1].text)
    end)

    it("retains terminal turn identity so either completion ordering finishes once", function()
        for _, state_first in ipairs({ true, false }) do
            local manager = opened()
            assert.is_true(manager:_handle_input_submit("input"))
            local prompt = request("session/prompt")
            local turn = prompt.params._meta.agency.submissionId
            state(manager, turn, "running")
            if state_first then state(manager, nil, "idle") end
            client:_handle_message({ id = prompt.id, result = { stopReason = "end_turn" } })
            flush()
            if not state_first then state(manager, nil, "idle") end
            assert.is_false(manager.is_generating)
            assert.are.equal(turn, manager._agency_turn_id)
        end
    end)

    it("suppresses only the originating live echo and never prepends replay on submission", function()
        local manager = opened()
        manager.history_to_send = { { type = "user", text = "old transcript" } }
        assert.is_true(manager:_handle_input_submit("input"))
        local prompt = request("session/prompt")
        assert.are.same({ { type = "text", text = "input" } }, prompt.params.prompt)
        local params = { sessionId = logical, update = { sessionUpdate = "user_message_chunk", content = { type = "text", text = "input" } }, _meta = { agency = { submissionId = prompt.params._meta.agency.submissionId, replay = false } } }
        client:_handle_message({ method = "session/update", params = params })
        flush()
        assert.are.equal(1, #manager.chat_history.messages)
        params._meta.agency.replay = true
        client:_handle_message({ method = "session/update", params = params })
        flush()
        assert.are.equal(2, #manager.chat_history.messages)
    end)

    it("rejects delayed prompt completion after same-ID load and replacement turn", function()
        local manager = opened()
        manager:_handle_input_submit("old")
        local old = request("session/prompt")
        state(manager, old.params._meta.agency.submissionId, "running")
        manager:load_acp_session(logical)
        local replacement = vim.tbl_extend("force", binding, { providerGeneration = "44444444-4444-4444-8444-444444444444" })
        reply(request("session/load"), nil, nil, replacement)
        flush()
        manager:_handle_input_submit("new")
        local current = request("session/prompt")
        state(manager, current.params._meta.agency.submissionId, "running", replacement)
        local before = vim.api.nvim_buf_get_lines(manager.widget.buf_nrs.chat, 0, -1, false)
        client:_handle_message({ id = old.id, result = { stopReason = "end_turn" } })
        flush()
        assert.is_true(manager.is_generating)
        assert.are.same(before, vim.api.nvim_buf_get_lines(manager.widget.buf_nrs.chat, 0, -1, false))
    end)

    it("does not let superseded loads apply settings or remove the latest subscription", function()
        local manager = opened()
        manager:load_acp_session(logical)
        local old = request("session/load")
        manager:load_acp_session(logical)
        local latest = request("session/load")
        local epoch = manager._agency_epoch
        assert.is_nil(manager.session_id)
        client:_handle_message({ id = old.id, error = { code = -1, message = "old failure" } })
        assert.are.equal(epoch, client.subscribers[logical]._agency_epoch)
        reply(latest, "claude-agent-acp", { configOptions = {}, modes = { currentModeId = "review", availableModes = { { id = "review", name = "Review" } } } })
        flush()
        assert.are.equal("review", manager.config_options:get_mode_id())
        assert.are.equal("claude-agent-acp", manager.session_state._provider_name)
    end)

    it("keeps a load completion valid when a shared turn changes during replay", function()
        local manager = opened()
        manager:load_acp_session(logical)
        state(manager, "shared-new", "running")
        reply(request("session/load"))
        flush()
        assert.are.equal(logical, manager.session_id)
        assert.is_true(manager.is_generating)
    end)

    it("passes fresh environment and manager-local backend choices on each new session", function()
        vim.env.AGENCY_TEST_EDITOR_MARKER = "first"
        local manager = integration.new_session({ backend_id = "claude-agent-acp", cwd = "/first" })
        flush()
        local first = request("session/new")
        assert.are.equal("claude-agent-acp", first.params._meta.agency.backendId)
        assert.are.equal("first", first.params._meta.agency.environment.AGENCY_TEST_EDITOR_MARKER)
        reply(first, "claude-agent-acp")
        flush()
        vim.env.AGENCY_TEST_EDITOR_MARKER = "second"
        manager:new_session()
        local second = request("session/new")
        assert.are.equal("second", second.params._meta.agency.environment.AGENCY_TEST_EDITOR_MARKER)
        assert.are.equal(logical, second.params._meta.agency.inheritSessionId)
        assert.is_nil(second.params._meta.agency.backendId)
        vim.env.AGENCY_TEST_EDITOR_MARKER = nil
    end)

    it("passes structured initial context through the native prompt boundary", function()
        local manager = integration.new_session({ initial_context = { { type = "resource_link", uri = "file:///context.lua", name = "context.lua" } } })
        flush()
        reply(request("session/new"))
        flush()
        manager._is_first_message = false
        manager:_handle_input_submit("input")
        assert.are.same({ { type = "text", text = "input" }, { type = "resource_link", uri = "file:///context.lua", name = "context.lua" } }, request("session/prompt").params.prompt)
    end)

    it("guards both invocation and queued native completion before effects", function()
        local manager = opened()
        local calls = 0
        local guarded = integration.guard_callback(manager, { epoch = manager._agency_epoch, binding = binding, check_binding = true, turn_id = "turn-a", check_turn = true }, function() calls = calls + 1 end)
        manager._agency_turn_id = "turn-b"
        guarded()
        assert.are.equal(0, calls)
    end)

    local function permission(id)
        client:_handle_message({ id = id, method = "session/request_permission", params = {
            sessionId = logical, toolCall = { toolCallId = "shared-tool", title = "Write", kind = "other", status = "pending" },
            options = { { optionId = "allow", name = "Allow", kind = "allow_once" }, { optionId = "reject", name = "Reject", kind = "reject_once" } },
            _meta = { agency = { version = 1, binding = binding, requestId = id } },
        } })
        flush()
    end

    it("treats nil permission callbacks as frontend abandonment", function()
        local manager = opened()
        permission("permission-a")
        assert.is_true(manager.permission_manager:has_pending())
        manager.permission_manager:clear()
        local response = frames[#frames]
        assert.are.equal("permission-a", response.id)
        assert.are.same({ outcome = "cancelled" }, response.result.outcome)
    end)

    it("withdraws only the exact request rather than a newer same-tool request", function()
        local manager = opened()
        permission("permission-a")
        manager.permission_manager:clear()
        permission("permission-b")
        client:_handle_message({ method = "agency/permission_withdrawn", params = { sessionId = logical, binding = binding, requestId = "permission-a", toolCallId = "shared-tool" } })
        flush()
        assert.is_true(manager.permission_manager:has_pending())
        client:_handle_message({ method = "agency/permission_withdrawn", params = { sessionId = logical, binding = binding, requestId = "permission-b", toolCallId = "shared-tool" } })
        flush()
        assert.is_false(manager.permission_manager:has_pending())
    end)

    it("preserves unsent input and native context after failed admission", function()
        local manager = opened()
        vim.api.nvim_buf_set_lines(manager.widget.buf_nrs.input, 0, -1, false, { "unsent" })
        manager.code_selection:add({ file_path = "/context.lua", file_type = "lua", start_line = 1, end_line = 1, lines = { "context" } })
        manager.widget:_submit_input()
        local prompt = request("session/prompt")
        client:_handle_message({ id = prompt.id, error = { code = -32000, message = "busy" } })
        flush()
        assert.are.same({ "unsent" }, vim.api.nvim_buf_get_lines(manager.widget.buf_nrs.input, 0, -1, false))
        assert.is_false(manager.code_selection:is_empty())
    end)

    it("does not overwrite later typed input when admission fails", function()
        local manager = opened()
        manager:_handle_input_submit("unsent")
        local prompt = request("session/prompt")
        vim.api.nvim_buf_set_lines(manager.widget.buf_nrs.input, 0, -1, false, { "later input" })
        client:_handle_message({ id = prompt.id, error = { code = -32000, message = "busy" } })
        flush()
        assert.are.same({ "later input" }, vim.api.nvim_buf_get_lines(manager.widget.buf_nrs.input, 0, -1, false))
    end)

    it("does not restore an accepted prompt as unsent after provider failure", function()
        local manager = opened()
        manager:_handle_input_submit("accepted")
        local prompt = request("session/prompt")
        state(manager, prompt.params._meta.agency.submissionId, "running")
        client:_handle_message({ id = prompt.id, error = { code = -32000, message = "provider failure" } })
        flush()
        assert.are.same({ "" }, vim.api.nvim_buf_get_lines(manager.widget.buf_nrs.input, 0, -1, false))
    end)

    it("discards permission requests for a superseded provider binding", function()
        local manager = opened()
        manager:load_acp_session(logical)
        reply(request("session/load"), nil, nil, vim.tbl_extend("force", binding, { providerGeneration = "44444444-4444-4444-8444-444444444444" }))
        flush()
        permission("stale-permission")
        assert.is_false(manager.permission_manager:has_pending())
    end)

    it("discards setter completion after reloading the same logical session", function()
        local manager, called = opened(), 0
        client:set_model(logical, "old-model", function() called = called + 1 end)
        local setter = request("session/set_model")
        manager:load_acp_session(logical)
        reply(request("session/load"))
        flush()
        client:_handle_message({ id = setter.id, result = { models = {} } })
        flush()
        assert.are.equal(0, called)
    end)

    it("leaves direct-provider constructor cancellation and nil permissions unchanged", function()
        local direct = { name = "Direct fixture", command = vim.v.progpath }
        Config.provider, Config.acp_providers.direct_fixture = "direct_fixture", direct
        client.provider_config = direct
        Instances._instances.direct_fixture = client
        local manager = Registry.get_session_for_tab_page()
        flush()
        local create = request("session/new")
        assert.is_nil(create.params._meta)
        client:_handle_message({ id = create.id, result = { sessionId = logical } })
        flush()
        permission("direct-permission")
        manager.permission_manager:clear()
        assert.are.equal("selected", frames[#frames].result.outcome.outcome)
        manager:destroy()
        assert.are.equal(logical, request("session/cancel").params.sessionId)
        Config.acp_providers.direct_fixture = nil
    end)
end)