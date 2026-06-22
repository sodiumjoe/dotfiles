describe("agentic codex provider", function()
    local tool_call_log = vim.fn.stdpath("state") .. "/agentic-codex-tool-call.log"

    local function load_agentic_setup()
        package.loaded["sodium.plugins.agentic"] = nil
        package.loaded.agentic = {
            setup = function(opts)
                _G.__agentic_setup_opts = opts
            end,
        }

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

    before_each(function()
        package.loaded["agentic.acp.acp_client"] = nil
        package.loaded["sodium.plugins.agentic"] = nil
        package.loaded.agentic = nil
        _G.__agentic_setup_opts = nil
        pcall(vim.fn.delete, tool_call_log)
    end)

    after_each(function()
        package.loaded["agentic.acp.acp_client"] = nil
        package.loaded["sodium.plugins.agentic"] = nil
        package.loaded.agentic = nil
        _G.__agentic_setup_opts = nil
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

    it("documents plain path:line file references in shared instructions", function()
        local text = table.concat(vim.fn.readfile("shared/base-instructions.md"), "\n"):lower()

        assert.truthy(text:find("path:line", 1, true))
        assert.truthy(text:find("do not use markdown file links", 1, true))
    end)
end)
