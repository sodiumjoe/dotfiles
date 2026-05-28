describe("agentic codex provider", function()
    local function load_agentic_setup()
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

    it("uses the full-access wrapper with the resolved codex executable", function()
        local opts = load_agentic_setup()
        local provider = opts.acp_providers["codex-acp"]

        assert.are.equal("codex-acp", opts.provider)
        assert.are.equal("codex-acp", provider.command)
        assert.are.equal(
            vim.fn.fnamemodify("bin/codex-full-access", ":p"),
            provider.env.CODEX_PATH
        )
        assert.are.equal(
            vim.fn.resolve(vim.fn.exepath("codex")),
            provider.env.CODEX_REAL_PATH
        )
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

    it("documents plain path:line file references in shared instructions", function()
        local text = table.concat(vim.fn.readfile("shared/base-instructions.md"), "\n"):lower()

        assert.truthy(text:find("path:line", 1, true))
        assert.truthy(text:find("do not use markdown file links", 1, true))
    end)
end)