describe("keymaps", function()
    local function find_nmap(lhs)
        for _, m in ipairs(vim.api.nvim_get_keymap("n")) do
            if m.lhs == lhs then
                return m
            end
        end
        return nil
    end

    describe("core keymaps", function()
        it("maps j to gj", function()
            local m = find_nmap("j")
            assert.is_not_nil(m)
            assert.are.equal("gj", m.rhs)
        end)

        it("maps k to gk", function()
            local m = find_nmap("k")
            assert.is_not_nil(m)
            assert.are.equal("gk", m.rhs)
        end)

        it("maps leader-cr for relative path copy", function()
            local m = find_nmap(" cr")
            assert.is_not_nil(m)
            assert.is_truthy(m.rhs:find("expand"))
        end)

        it("maps leader-cf for full path copy", function()
            local m = find_nmap(" cf")
            assert.is_not_nil(m)
            assert.is_truthy(m.rhs:find("expand"))
        end)

        it("maps review keymaps in core config", function()
            assert.is_not_nil(find_nmap(" pf"))
            assert.is_not_nil(find_nmap(" pn"))
            assert.is_not_nil(find_nmap(" pa"))
            assert.is_not_nil(find_nmap(" px"))
            assert.is_not_nil(find_nmap(" ps"))
            assert.is_not_nil(find_nmap(" p?"))
        end)

        it("registers the Review command", function()
            assert.is_truthy(vim.api.nvim_get_commands({})["Review"])
        end)
    end)

    describe("plugin keymaps (declared in specs)", function()
        local function spec_has_key(specs, lhs)
            if type(specs) ~= "table" then
                return false
            end
            if specs[1] and type(specs[1]) == "string" then
                if specs.keys then
                    for _, key in ipairs(specs.keys) do
                        local key_lhs = type(key) == "table" and key[1] or key
                        if key_lhs == lhs then
                            return true
                        end
                    end
                end
                return false
            end
            for _, spec in ipairs(specs) do
                if spec_has_key(spec, lhs) then
                    return true
                end
            end
            return false
        end

        local function find_spec_key(specs, lhs)
            if type(specs) ~= "table" then
                return nil
            end
            if specs[1] and type(specs[1]) == "string" then
                if specs.keys then
                    for _, key in ipairs(specs.keys) do
                        local key_lhs = type(key) == "table" and key[1] or key
                        if key_lhs == lhs then
                            return key
                        end
                    end
                end
                return nil
            end
            for _, spec in ipairs(specs) do
                local key = find_spec_key(spec, lhs)
                if key then
                    return key
                end
            end
            return nil
        end

        local pickers = require("sodium.plugins.pickers")
        local editing = require("sodium.plugins.editing")

        it("declares C-p in pickers spec", function()
            assert.is_true(spec_has_key(pickers, "<C-p>"))
        end)

        it("declares leader-/ in pickers spec", function()
            assert.is_true(spec_has_key(pickers, "<leader>/"))
        end)

        it("declares leader-sb in pickers spec", function()
            assert.is_true(spec_has_key(pickers, "<leader>sb"))
        end)

        it("declares leader-ew in editing spec", function()
            assert.is_true(spec_has_key(editing, "<leader>ew"))
        end)

        it("declares leader-e/ in editing spec", function()
            assert.is_true(spec_has_key(editing, "<leader>e/"))
        end)

        local ok, agentic = pcall(require, "sodium.plugins.agentic")
        if ok then
            it("warms the model catalog after VimEnter", function()
                local model_catalog = require("sodium.agentic_models")
                local original_discover = model_catalog.discover
                local original_create_autocmd = vim.api.nvim_create_autocmd
                local registered_event
                local registered_opts
                local discovery_calls = 0

                model_catalog.discover = function(callback)
                    discovery_calls = discovery_calls + 1
                    callback({}, {})
                end
                vim.api.nvim_create_autocmd = function(event, opts)
                    registered_event = event
                    registered_opts = opts
                    return 1
                end

                local ok2, err = pcall(function()
                    assert.is_function(agentic.init)
                    agentic.init()
                    assert.are.equal("VimEnter", registered_event)
                    assert.is_true(registered_opts.once)
                    registered_opts.callback()
                end)

                model_catalog.discover = original_discover
                vim.api.nvim_create_autocmd = original_create_autocmd

                if not ok2 then
                    error(err)
                end

                assert.are.equal(1, discovery_calls)
            end)

            it("declares leader-a= in agentic spec", function()
                assert.is_true(spec_has_key(agentic, "<leader>a="))
            end)

            it("maps leader-an to the combined model picker", function()
                local key = find_spec_key(agentic, "<leader>an")
                assert.is_not_nil(key)
                assert.is_function(key[2])

                local original_agentic = package.loaded.agentic
                local original_config = package.loaded["agentic.config"]
                local original_health = package.loaded["agentic.acp.acp_health"]
                local model_catalog = require("sodium.agentic_models")
                local original_pick = model_catalog.pick
                local original_snacks = _G.Snacks
                local called = false
                local picked = false
                package.loaded.agentic = {
                    new_session = function(opts)
                        assert.are.equal("codex-acp", opts.provider)
                        assert.are.equal(
                            "gpt-5.6-sol",
                            package.loaded["agentic.config"].acp_providers["codex-acp"].initial_model
                        )
                        called = true
                    end,
                }
                package.loaded["agentic.config"] = {
                    provider = "codex-acp",
                    acp_providers = {
                        ["codex-acp"] = { command = "codex-acp" },
                        ["gemini-acp"] = { command = "gemini-acp" },
                    },
                }
                package.loaded["agentic.acp.acp_health"] = {
                    get_default_provider_names = function()
                        return { "gemini-acp", "codex-acp" }
                    end,
                    is_command_available = function()
                        return true
                    end,
                }
                model_catalog.pick = function(callback)
                    picked = true
                    callback({ provider = "codex-acp", model_id = "gpt-5.6-sol" })
                end
                _G.Snacks = {
                    picker = function(opts)
                        opts.confirm({ close = function() end }, opts.items[1])
                    end,
                }

                local ok2, err = pcall(key[2])
                package.loaded.agentic = original_agentic
                package.loaded["agentic.config"] = original_config
                package.loaded["agentic.acp.acp_health"] = original_health
                model_catalog.pick = original_pick
                _G.Snacks = original_snacks

                if not ok2 then
                    error(err)
                end

                assert.is_true(picked)
                assert.is_true(called)
            end)

            it("maps leader-ac to the combined model picker when no session exists", function()
                local key = find_spec_key(agentic, "<leader>ac")
                local original_agentic = package.loaded.agentic
                local original_config = package.loaded["agentic.config"]
                local original_health = package.loaded["agentic.acp.acp_health"]
                local original_registry = package.loaded["agentic.session_registry"]
                local model_catalog = require("sodium.agentic_models")
                local original_pick = model_catalog.pick
                local picked = false
                local started = false

                package.loaded.agentic = {
                    new_session = function(opts)
                        assert.are.equal("claude-agent-acp", opts.provider)
                        assert.are.equal(
                            "sonnet",
                            package.loaded["agentic.config"].acp_providers["claude-agent-acp"].initial_model
                        )
                        started = true
                    end,
                }
                package.loaded["agentic.config"] = {
                    provider = "claude-agent-acp",
                    acp_providers = {
                        ["claude-agent-acp"] = { command = "claude-agent-acp" },
                    },
                }
                package.loaded["agentic.acp.acp_health"] = {
                    get_default_provider_names = function()
                        return { "claude-agent-acp" }
                    end,
                    is_command_available = function()
                        return true
                    end,
                }
                package.loaded["agentic.session_registry"] = { sessions = {} }
                model_catalog.pick = function(callback)
                    picked = true
                    callback({ provider = "claude-agent-acp", model_id = "sonnet" })
                end

                local ok2, err = pcall(key[2])
                package.loaded.agentic = original_agentic
                package.loaded["agentic.config"] = original_config
                package.loaded["agentic.acp.acp_health"] = original_health
                package.loaded["agentic.session_registry"] = original_registry
                model_catalog.pick = original_pick

                if not ok2 then
                    error(err)
                end

                assert.is_true(picked)
                assert.is_true(started)
            end)

            it("keeps leader-ac as a toggle when a session exists", function()
                local key = find_spec_key(agentic, "<leader>ac")
                local original_agentic = package.loaded.agentic
                local original_registry = package.loaded["agentic.session_registry"]
                local model_catalog = require("sodium.agentic_models")
                local original_pick = model_catalog.pick
                local tab_page_id = vim.api.nvim_get_current_tabpage()
                local toggled = false
                local picked = false

                package.loaded.agentic = {
                    toggle = function()
                        toggled = true
                    end,
                }
                package.loaded["agentic.session_registry"] = {
                    sessions = { [tab_page_id] = {} },
                }
                model_catalog.pick = function()
                    picked = true
                end

                local ok2, err = pcall(key[2])
                package.loaded.agentic = original_agentic
                package.loaded["agentic.session_registry"] = original_registry
                model_catalog.pick = original_pick

                if not ok2 then
                    error(err)
                end

                assert.is_true(toggled)
                assert.is_false(picked)
            end)

            it("declares leader-pr in agentic spec", function()
                assert.is_true(spec_has_key(agentic, "<leader>pr"))
            end)

            it("does not declare review file keymaps in agentic spec", function()
                assert.is_false(spec_has_key(agentic, "<leader>pf"))
                assert.is_false(spec_has_key(agentic, "<leader>pn"))
                assert.is_false(spec_has_key(agentic, "<leader>pa"))
            end)
        end

        local markdown = require("sodium.plugins.markdown")

        it("declares leader-wp in markdown spec", function()
            assert.is_true(spec_has_key(markdown, "<leader>wp"))
        end)

        it("declares leader-ww in markdown spec", function()
            assert.is_true(spec_has_key(markdown, "<leader>ww"))
        end)

        local lsp_keymaps = require("sodium.plugins.lsp.keymaps")

        it("declares leader-f in lsp keymaps spec", function()
            assert.is_true(spec_has_key(lsp_keymaps, "<leader>f"))
        end)

        it("declares leader-ca in lsp keymaps spec", function()
            assert.is_true(spec_has_key(lsp_keymaps, "<leader>ca"))
        end)
    end)
end)
