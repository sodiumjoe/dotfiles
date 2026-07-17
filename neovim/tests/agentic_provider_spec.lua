describe("agentic codex provider", function()
    local tool_call_log = vim.fn.stdpath("state") .. "/agentic-codex-tool-call.log"

    local function load_agentic_setup(opts)
        opts = opts or {}
        package.loaded["sodium.plugins.agentic"] = nil
        package.loaded.agentic = {
            setup = function(opts)
                _G.__agentic_setup_opts = opts
            end,
        }
        package.loaded["agentic.session_restore"] = opts.session_restore

        local ok, spec = pcall(require, "sodium.plugins.agentic")
        assert.is_true(ok)
        assert.is_function(spec.config)

        _G.__agentic_setup_opts = nil
        spec.config()

        local opts = _G.__agentic_setup_opts
        _G.__agentic_setup_opts = nil
        package.loaded.agentic = nil
        return opts
    end

    local function session_ids(sessions)
        local ids = {}
        for i, session in ipairs(sessions or {}) do
            ids[i] = session.sessionId
        end
        return ids
    end

    before_each(function()
        package.loaded["agentic.acp.acp_client"] = nil
        package.loaded["agentic.session_restore"] = nil
        package.loaded["sodium.plugins.agentic"] = nil
        package.loaded.agentic = nil
        _G.__agentic_setup_opts = nil
        _G.__agentic_listed_sessions = nil
        pcall(vim.fn.delete, tool_call_log)
    end)

    after_each(function()
        package.loaded["agentic.acp.acp_client"] = nil
        package.loaded["agentic.session_restore"] = nil
        package.loaded["sodium.plugins.agentic"] = nil
        package.loaded.agentic = nil
        _G.__agentic_setup_opts = nil
        _G.__agentic_listed_sessions = nil
        pcall(vim.fn.delete, tool_call_log)
    end)

    it("passes the resolved codex executable directly to codex-acp", function()
        local opts = load_agentic_setup()
        local provider = opts.acp_providers["codex-acp"]

        assert.are.equal("codex-acp", opts.provider)
        assert.are.equal("codex-acp", provider.command)
        assert.are.equal(
            vim.fn.resolve(vim.fn.exepath("codex")),
            provider.env.CODEX_PATH
        )
        assert.is_nil(provider.env.CODEX_REAL_PATH)
    end)

    it("forwards the current neovim server to codex", function()
        local opts = load_agentic_setup()
        local provider = opts.acp_providers["codex-acp"]

        assert.are.equal(vim.v.servername, provider.env.NVIM)
    end)

    it("starts codex sessions in full-access mode", function()
        local opts = load_agentic_setup()
        local provider = opts.acp_providers["codex-acp"]

        assert.are.equal("agent-full-access", provider.default_mode)
        assert.are.equal("agent-full-access", provider.env.INITIAL_AGENT_MODE)
    end)

    it("forces codex-acp to use the litellm model provider", function()
        local opts = load_agentic_setup()
        local provider = opts.acp_providers["codex-acp"]

        assert.are.equal("litellm", provider.env.MODEL_PROVIDER)
    end)

    it("runs the agent notification hook when a response completes", function()
        local original_jobstart = vim.fn.jobstart
        local captured_cmd
        local captured_opts

        vim.fn.jobstart = function(cmd, opts)
            captured_cmd = cmd
            captured_opts = opts
            return 1
        end

        local ok, err = pcall(function()
            local opts = load_agentic_setup()
            assert.is_function(opts.hooks.on_response_complete)

            opts.hooks.on_response_complete({
                session_id = "session-1",
                tab_page_id = 1,
                success = true,
            })
        end)

        vim.fn.jobstart = original_jobstart

        if not ok then
            error(err)
        end

        assert.are.same(
            { vim.fn.expand("$HOME/.claude/hooks/notify-on-idle.sh") },
            captured_cmd
        )
        assert.are.same({ NOTIFY_AGENT_NAME = "Agent" }, captured_opts.env)
        assert.is_true(captured_opts.detach)
    end)

    it("tolerates tool calls with vim.NIL content", function()
        load_agentic_setup()
        local ACPClient = require("agentic.acp.acp_client")

        local ok, message = pcall(function()
            return ACPClient.__build_tool_call_message(ACPClient, {
                toolCallId = "tool-1",
                kind = "execute",
                status = "pending",
                content = vim.NIL,
            })
        end)

        assert.is_true(ok)
        assert.are.equal("tool-1", message.tool_call_id)
        assert.is_nil(message.body)
    end)

    it("logs malformed top-level tool-call fields", function()
        load_agentic_setup()
        local ACPClient = require("agentic.acp.acp_client")

        local ok = pcall(function()
            return ACPClient.__build_tool_call_message(ACPClient, {
                toolCallId = "tool-2",
                kind = "execute",
                status = "pending",
                title = vim.NIL,
                content = vim.NIL,
                rawInput = vim.NIL,
                locations = vim.NIL,
            })
        end)

        assert.is_true(ok)

        local text = table.concat(vim.fn.readfile(tool_call_log), "\n")
        assert.truthy(text:find("\"event\":\"malformed_tool_call_payload\"", 1, true))
        assert.truthy(text:find("\"toolCallId\":\"tool-2\"", 1, true))
        assert.truthy(text:find("\"content\":\"userdata\"", 1, true))
    end)

    it("logs and falls back when upstream tool-call rendering raises", function()
        local ACPClient = require("agentic.acp.acp_client")
        ACPClient.__build_tool_call_message = function()
            error("bad argument #1 to 'ipairs' (table expected, got userdata)")
        end
        ACPClient._sodium_null_field_patch = nil

        load_agentic_setup()

        local ok, message = pcall(function()
            return ACPClient.__build_tool_call_message(ACPClient, {
                toolCallId = "tool-3",
                kind = "read",
                status = "pending",
                title = "Read file",
                content = vim.NIL,
                locations = {
                    { path = "/tmp/example.txt" },
                },
            })
        end)

        assert.is_true(ok)
        assert.are.equal("tool-3", message.tool_call_id)
        assert.are.equal("read", message.kind)
        assert.are.equal("pending", message.status)
        assert.are.equal("Read file", message.argument)
        assert.are.equal("/tmp/example.txt", message.file_path)

        local text = table.concat(vim.fn.readfile(tool_call_log), "\n")
        assert.truthy(text:find("\"event\":\"tool_call_render_error\"", 1, true))
        assert.truthy(text:find("bad argument #1 to 'ipairs' (table expected, got userdata)", 1, true))
        assert.truthy(text:find("\"toolCallId\":\"tool-3\"", 1, true))
    end)

    it("sorts restore sessions newest-first with malformed timestamps last", function()
        local SessionRestore = {
            show_picker = function(current_session)
                current_session.agent:when_ready(function()
                    current_session.agent:list_sessions(vim.fn.getcwd(), function(result)
                        _G.__agentic_listed_sessions = result.sessions
                    end)
                end)
            end,
        }

        load_agentic_setup({ session_restore = SessionRestore })

        SessionRestore.show_picker({
            agent = {
                when_ready = function(_, callback)
                    callback()
                end,
                list_sessions = function(_, _, callback)
                    callback({
                        sessions = {
                            {
                                sessionId = "older",
                                updatedAt = "2026-03-20T14:30:00Z",
                            },
                            {
                                sessionId = "invalid",
                                updatedAt = "not-a-date",
                            },
                            {
                                sessionId = "newest",
                                updatedAt = "2026-03-21T09:15:00Z",
                            },
                            {
                                sessionId = "missing",
                            },
                        },
                    }, nil)
                end,
            },
        })

        assert.are.same(
            { "newest", "older", "invalid", "missing" },
            session_ids(_G.__agentic_listed_sessions)
        )
    end)

    it("documents plain path:line file references in shared instructions", function()
        local text = table.concat(vim.fn.readfile("shared/base-instructions.md"), "\n"):lower()

        assert.truthy(text:find("path:line", 1, true))
        assert.truthy(text:find("do not use markdown file links", 1, true))
    end)
end)
