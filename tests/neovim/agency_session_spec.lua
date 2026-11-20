package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
dofile(vim.env.DOTFILES_TEST_ROOT .. "/home/.config/nvim/lua/sodium/plugins/agentic.lua").config()

describe("Agency session start and release", function()
    local f, control, Registry, adapter
    before_each(function()
        f = require("fixtures.agency_native").new()
        control, Registry, adapter =
            require("fixtures.agency_control"), require("agentic.session_registry"), require("sodium.agency.agentic")
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
        local manager = adapter.new_session({
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
        for _, item in ipairs(require("agentic.states").getSlashCommands(manager.widget.buf_nrs.input)) do
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
end)