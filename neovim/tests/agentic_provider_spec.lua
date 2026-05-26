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

    it("uses the PATH codex adapter and resolved codex executable", function()
        local opts = load_agentic_setup()
        local provider = opts.acp_providers["codex-acp"]

        assert.are.equal("codex-acp", opts.provider)
        assert.are.equal("codex-acp", provider.command)
        assert.are.equal(vim.fn.resolve(vim.fn.exepath("codex")), provider.env.CODEX_PATH)
    end)

    it("forwards the current neovim server to codex", function()
        local opts = load_agentic_setup()
        local provider = opts.acp_providers["codex-acp"]

        assert.are.equal(vim.v.servername, provider.env.NVIM)
    end)
end)
