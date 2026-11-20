package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
dofile(vim.env.DOTFILES_TEST_ROOT .. "/home/.config/nvim/lua/sodium/plugins/agentic.lua").config()

describe("Agency session start and release", function()
    local f, control, Registry, adapter
    before_each(function()
        f = require("fixtures.agency_native").new()
        control, Registry, adapter =
            require("fixtures.agency_control"), require("agentic.session_registry"), require("sodium.agency")
    end)
    after_each(function()
        f.close()
    end)
    local function since(start, method)
        local found = {}
        for i = start + 1, #f.frames do
            if f.frames[i].method == method then
                found[#found + 1] = f.frames[i]
            end
        end
        return found
    end
    local function reply(frame, id, target, extra)
        f.client:_handle_message({
            id = frame.id,
            result = vim.tbl_extend(
                "force",
                {
                    sessionId = id,
                    configOptions = {},
                    availableCommands = {},
                    _meta = {
                        agency = {
                            version = 1,
                            binding = target,
                            backendId = "claude-agent-acp",
                            configuration = { configOptions = {}, availableCommands = {} },
                        },
                    },
                },
                extra or {}
            ),
        })
        f.flush()
    end

    it("detaches a created session whose manager was destroyed before the reply", function()
        local start = #f.frames
        local manager = adapter.new(nil, {
            cwd = vim.fn.getcwd(),
            backend_id = "claude-agent-acp",
            selection = { modeId = "default" },
        })
        f.flush()
        local frame = since(start, "session/new")[1]
        assert.are.equal("claude-agent-acp", frame.params._meta.agency.backendId)
        assert.are.same({ modeId = "default" }, frame.params._meta.agency.selection)
        assert.are.equal(vim.v.servername, frame.params._meta.agency.environment.NVIM)
        Registry.destroy(manager.session_key)
        f.flush()
        local id = "agency:" .. control.target_b.agentId
        reply(frame, id, control.target_b)
        assert.are.same(
            { { jsonrpc = "2.0", method = "agency/detach", params = { sessionId = id } } },
            since(start, "agency/detach")
        )
        assert.are.same({}, since(start, "session/cancel"))
        assert.is_nil(f.client.subscribers[id])
    end)

    it("detaches a session destroyed during its load and renders nothing from the late reply", function()
        local start = #f.frames
        local manager = adapter.open(control.agent(control.target_b))
        f.flush()
        local frame = since(start, "session/load")[1]
        assert.are.same({ version = 1, editor = vim.v.servername }, frame.params._meta.agency)
        local writes, write = 0, manager.message_writer.write_message
        manager.message_writer.write_message = function(...)
            writes = writes + 1
            return write(...)
        end
        Registry.destroy(manager.session_key)
        f.flush()
        assert.are.same(
            { { jsonrpc = "2.0", method = "agency/detach", params = { sessionId = frame.params.sessionId } } },
            since(start, "agency/detach")
        )
        f.client:_handle_message({
            method = "session/update",
            params = {
                sessionId = frame.params.sessionId,
                update = { sessionUpdate = "agent_message_chunk", content = { type = "text", text = "late" } },
            },
        })
        reply(
            frame,
            frame.params.sessionId,
            control.target_b,
            {
                _meta = {
                    agency = {
                        version = 1,
                        binding = control.target_b,
                        backendId = "claude-agent-acp",
                        historyTruncated = true,
                        configuration = { configOptions = {}, availableCommands = {} },
                    },
                },
            }
        )
        assert.are.equal(0, writes)
        assert.is_nil(manager._agency_binding)
        assert.are.equal(1, #since(start, "agency/detach"))
    end)

    it("applies slash commands, legacy models and the backend name from the attachment", function()
        local start = #f.frames
        local manager = adapter.open(control.agent(control.target_b))
        f.flush()
        local frame = since(start, "session/load")[1]
        local configuration = {
            configOptions = {},
            availableCommands = { { name = "review", description = "Review changes" } },
            models = {
                currentModelId = "opus",
                availableModels = { { modelId = "opus", name = "Opus", description = "" } },
            },
        }
        reply(
            frame,
            frame.params.sessionId,
            control.target_b,
            vim.tbl_extend("force", vim.deepcopy(configuration), {
                _meta = {
                    agency = {
                        version = 1,
                        binding = control.target_b,
                        backendId = "claude-agent-acp",
                        turnId = "turn-1",
                        configuration = configuration,
                    },
                },
            })
        )
        f.flush()
        assert.are.same(control.target_b, manager._agency_binding)
        assert.are.equal("turn-1", manager._agency_turn_id)
        local words = {}
        local commands = vim.api.nvim_buf_call(manager.widget.buf_nrs.input, require("agentic.states").getSlashCommands)
        for _, item in ipairs(commands) do
            words[#words + 1] = item.word
        end
        assert.are.same({ "review", "new" }, words)
        assert.are.equal("Opus", manager.config_options.legacy_agent_models:get_model("opus").name)
        assert.are.equal("claude-agent-acp", manager.session_state:get_provider_name())
        assert.are.equal("claude-agent-acp", manager.message_writer._provider_name)
    end)

    it("drops a late reply to a timed-out request without a missing callback warning", function()
        local notify, warnings = vim.notify, {}
        vim.notify = function(message)
            warnings[#warnings + 1] = message
        end
        local outcome
        local start = #f.frames
        f.client:request_with_timeout("agency/roster", {}, 10, function(_, err)
            outcome = err
        end)
        assert.is_true(vim.wait(1000, function()
            return outcome ~= nil
        end, 5))
        f.client:_handle_message({ id = since(start, "agency/roster")[1].id, result = { agents = {} } })
        f.flush()
        vim.notify = notify
        assert.are.equal(f.client.ERROR_CODES.TIMEOUT_ERROR, outcome.code)
        assert.are.same({}, warnings)
    end)

    it("leaves a released manager collectable", function()
        local start = #f.frames
        local held = setmetatable({ adapter.open(control.agent(control.target_b)) }, { __mode = "v" })
        f.flush()
        local frame = since(start, "session/load")[1]
        reply(frame, frame.params.sessionId, control.target_b)
        f.flush()
        assert.are.same(control.target_b, held[1]._agency_binding)
        Registry.destroy(held[1].session_key)
        vim.wait(300, function() return false end)
        collectgarbage()
        collectgarbage()
        assert.is_nil(held[1])
    end)

    it("inherits the predecessor's backend only when no backend is chosen", function()
        local start = #f.frames
        Registry.create("agency", { kind = "new", source_session_id = f.manager.session_id }, f.client)
        Registry.create("agency", { kind = "new", source_session_id = f.manager.session_id, meta = { backend_id = "codex-acp" } }, f.client)
        f.flush()
        local frames = since(start, "session/new")
        assert.are.equal(f.manager.session_id, frames[1].params._meta.agency.inheritSessionId)
        assert.is_nil(frames[2].params._meta.agency.inheritSessionId)
        assert.are.equal("codex-acp", frames[2].params._meta.agency.backendId)
    end)

    it("closes routed permissions when the session is released", function()
        local closed = 0
        f.manager._agency_routed_permissions = { close = function() closed = closed + 1 end }
        local manager, id = f.manager, f.manager.session_id
        Registry.destroy(manager.session_key)
        f.flush()
        assert.are.equal(1, closed)
        assert.is_nil(manager._agency_routed_permissions)
        assert.are.equal(id, f.request("agency/detach").params.sessionId)
    end)

    it("sends a new session's environment as text even when the Handler accepts embedded context", function()
        local client, start = f.client, #f.frames
        client.state, client.agent_capabilities, client._on_ready = "disconnected", nil, function() end
        client.transport.start = function()
            client.state = "connected"
        end
        client:_connect()
        client:_handle_message({
            id = since(start, "initialize")[1].id,
            result = {
                protocolVersion = 1,
                authMethods = {},
                agentCapabilities = { loadSession = true, promptCapabilities = { embeddedContext = true } },
            },
        })
        f.flush()
        assert.are.equal("ready", client.state)
        local manager = adapter.new(nil, { cwd = vim.fn.getcwd(), backend_id = "codex-acp" })
        f.flush()
        local id = "agency:" .. control.id(6)
        reply(
            since(start, "session/new")[1],
            id,
            { agentId = control.id(6), handlerGeneration = control.id(2), providerGeneration = control.id(7) }
        )
        vim.api.nvim_buf_set_lines(manager.widget.buf_nrs.input, 0, -1, false, { "Reply with exactly: ok" })
        manager.widget:_submit_input()
        local prompt = f.request("session/prompt").params.prompt
        assert.are.same({ type = "text", text = "Reply with exactly: ok" }, prompt[1])
        assert.are.equal("text", prompt[2].type)
        for _, block in ipairs(prompt) do
            assert.are_not.equal("resource", block.type)
        end
    end)

    it("announces one mode change when the backend reports modes both ways", function()
        local start = #f.frames
        local manager = adapter.open(control.agent(control.target_b))
        f.flush()
        local frame = since(start, "session/load")[1]
        local modes = { { id = "default", name = "Default" }, { id = "plan", name = "Plan" } }
        local configuration = {
            configOptions = { { id = "mode", name = "Mode", category = "mode", type = "select", currentValue = "plan",
                options = { { value = "default", name = "Default" }, { value = "plan", name = "Plan" } } } },
            modes = { currentModeId = "plan", availableModes = modes },
            availableCommands = {},
        }
        reply(frame, frame.params.sessionId, control.target_b, { _meta = { agency = { version = 1, binding = control.target_b,
            backendId = "claude-agent-acp", configuration = configuration } } })
        local notify, announced = vim.notify, {}
        vim.notify = function(message)
            if tostring(message):find("Mode changed to", 1, true) then announced[#announced + 1] = message end
        end
        local ok, failure = pcall(function()
            manager.config_options:handle_change("mode", "default")
            f.client:_handle_message({ id = since(start, "session/set_config_option")[1].id, result = {} })
            f.client:_handle_message({ method = "session/update", params = { sessionId = frame.params.sessionId,
                update = { sessionUpdate = "current_mode_update", currentModeId = "default" } } })
            f.flush()
        end)
        vim.notify = notify
        assert.is_true(ok, failure)
        assert.are.equal(1, #announced)
    end)

    it("adopts the requested cwd from the attachment", function()
        local start = #f.frames
        local row = control.agent(control.target_b)
        row.record.definition.cwd = "/work/b"
        local loaded = adapter.open(row)
        local created = adapter.new(nil, { cwd = "/work/new", backend_id = "codex-acp" })
        f.flush()
        local load, new = since(start, "session/load")[1], since(start, "session/new")[1]
        reply(load, load.params.sessionId, control.target_b)
        reply(new, "agency:" .. control.id(6), { agentId = control.id(6), handlerGeneration = control.id(2), providerGeneration = control.id(7) })
        f.flush()
        assert.are.equal("/work/b", loaded._agency_cwd)
        assert.are.equal("/work/new", created._agency_cwd)
    end)
end)