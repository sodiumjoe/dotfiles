package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
describe("Agency native commands", function()
    local f, api, select_ui, snacks, notifications
    before_each(function()
        f = require("fixtures.agency_native").new()
        package.loaded["sodium.agency"] = nil
        select_ui, snacks, notifications = vim.ui.select, _G.Snacks, {}
        vim.ui.select = function(items, _, callback) callback(items[1]) end
        api = require("sodium.agency").setup({ notify = function(value) notifications[#notifications + 1] = value end })
    end)
    after_each(function() vim.ui.select = select_ui; _G.Snacks = snacks; f.close() end)
    local function respond_fast(frame, result, err)
        local done, ok, failure = false, nil, nil
        local timer = assert(vim.uv.new_timer())
        timer:start(0, 0, function()
            timer:stop(); timer:close()
            ok, failure = pcall(function()
                assert.is_true(vim.in_fast_event())
                f.client:_handle_message({ id = frame.id, result = result, error = err })
            end)
            done = true
        end)
        assert.is_true(vim.wait(1000, function() return done end))
        f.flush()
        assert.is_true(ok, failure)
    end
    local function count(method)
        local n = 0
        for _, frame in ipairs(f.frames) do if frame.method == method then n = n + 1 end end
        return n
    end
    local function choices()
        return { defaultBackendId = "codex-acp", backends = { { id = "codex-acp", discovery = "fresh", defaults = {},
            models = { { id = "model-c", name = "C", selection = { configValues = { model = "model-c" } },
                settings = { { id = "reasoning_effort", name = "Reasoning effort", kind = "config", values = { { value = "medium", name = "medium" } } } } } },
            settings = { { id = "mode", name = "Mode", kind = "config", values = { { value = "read-only", name = "Read only" } } } } } } }
    end
    it("uses the cached ACP connection for active roster display outside fast events", function()
        local systems, complete, fast = 0, nil, nil
        local system = vim.system
        vim.system = function() systems = systems + 1; error("roster spawned CLI") end
        local ok, err = pcall(function()
            api.page({ active = true, allow_issues = true }, function(error, result)
                assert.is_nil(error); fast = vim.in_fast_event(); complete = result
            end)
            f.flush()
            local request = f.request("agency/roster")
            assert.are.same({ limit = 100 }, request.params)
            local page = require("fixtures.agency_control").page({ f.row })
            page.handlerGeneration = f.row.record.launch.handlerGeneration
            respond_fast(request, page)
            assert.are.equal(1, #complete.agents)
            assert.is_false(fast)
            assert.are.equal(0, systems)
        end)
        vim.system = system
        assert.is_true(ok, err)
    end)
    it("retries ACP roster resync once and rejects a changed Handler across pages", function()
        local failure
        api.page({ active = true }, function(err) failure = err end)
        f.flush()
        respond_fast(f.request("agency/roster"), nil, { code = -32000, message = "resync", data = { agency = { code = "RESYNC_REQUIRED" } } })
        assert.are.equal(2, count("agency/roster"))
        local control = require("fixtures.agency_control")
        local page = control.page({ f.row }, "next")
        page.handlerGeneration = f.row.record.launch.handlerGeneration
        respond_fast(f.request("agency/roster"), page)
        local other = control.page()
        other.handlerGeneration = control.id(99)
        respond_fast(f.request("agency/roster"), other)
        assert.are.equal("INVALID_PROTOCOL", failure.code)
    end)
    it("chooses only the model and preserves configured defaults before creation", function()
        local prompts = {}
        vim.ui.select = function(items, opts, callback)
            assert.are.equal(0, count("session/new"))
            assert.is_false(vim.in_fast_event())
            prompts[#prompts + 1] = opts.prompt
            callback(items[2])
        end
        api.new()
        f.flush()
        local result = choices()
        result.backends[1].defaults = { modeId = "agent-full-access", configValues = { reasoning_effort = "medium" } }
        respond_fast(f.request("agency/backends"), result)
        assert.are.same({ "Agency model" }, prompts)
        assert.are.same({ modeId = "agent-full-access", configValues = { model = "model-c", reasoning_effort = "medium" } }, f.request("session/new").params._meta.agency.selection)
    end)
    for _, stage in ipairs({ "Agency backend", "Agency model" }) do
        it("cancels without creating a conversation at " .. stage, function()
            vim.ui.select = function(items, opts, callback) callback(opts.prompt ~= stage and items[2] or nil) end
            api.new()
            f.flush()
            local result = choices()
            result.backends[2] = { id = "claude-agent-acp", models = {} }
            respond_fast(f.request("agency/backends"), result)
            assert.are.equal(0, count("session/new"))
            assert.are.equal("agency:" .. f.row.record.definition.agentId, f.manager.session_id)
        end)
        it("discards a superseded callback at " .. stage, function()
            local pending
            vim.ui.select = function(items, opts, callback)
                if opts.prompt == stage then pending = function() callback(items[2]) end else callback(items[2]) end
            end
            api.new()
            f.flush()
            local result = choices()
            result.backends[2] = { id = "claude-agent-acp", models = {} }
            respond_fast(f.request("agency/backends"), result)
            assert.is_function(pending)
            api.current()
            pending()
            f.flush()
            assert.are.equal(0, count("session/new"))
        end)
    end
    for _, name in ipairs({ "switch_provider", "new_session_with_provider" }) do
        it("routes native " .. name .. " through Agency selection", function()
            vim.ui.select = function(items, _, callback) callback(items[1]) end
            require("agentic")[name]()
            f.flush()
            respond_fast(f.request("agency/backends"), choices())
            assert.are.equal("codex-acp", f.request("session/new").params._meta.agency.backendId)
            assert.are.equal(0, count("session/prompt"))
        end)
        it("rejects a direct provider requested through native " .. name, function()
            vim.ui.select = function(_, _, callback) callback(nil) end
            require("agentic")[name]({ provider = "codex-acp" })
            f.flush()
            assert.are.equal(0, count("session/new"))
            assert.are.equal(0, count("agency/backends"))
            assert.are.equal("agency:" .. f.row.record.definition.agentId, f.manager.session_id)
        end)
    end
    for _, name in ipairs({ "switch_provider", "new_session_with_provider" }) do
        it("preserves native " .. name .. " under a direct-provider configuration", function()
            local Config, Registry = require("agentic.config"), require("agentic.session_registry")
            local select_provider = Registry.select_provider
            local direct = vim.deepcopy(Config.acp_providers.agency)
            Config.acp_providers["direct-fixture"] = direct
            Config.provider = "direct-fixture"
            require("agentic.acp.agent_instance")._instances["direct-fixture"] = f.client
            f.client.provider_config = direct
            Registry.select_provider = function(callback) callback("direct-fixture") end
            local ok, err = pcall(function()
                require("agentic")[name]()
                f.flush()
                assert.are.equal(0, count("agency/backends"))
                assert.are.equal(1, count("session/new"))
                assert.is_nil(f.request("session/new").params._meta)
                assert.are.equal("direct-fixture", Config.provider)
            end)
            Registry.select_provider = select_provider
            Config.acp_providers["direct-fixture"] = nil
            assert.is_true(ok, err)
        end)
    end
    it("labels unavailable discovery while retaining configured defaults", function()
        local label
        vim.ui.select = function(items, opts, callback)
            label = opts.format_item(items[1])
            callback(items[1])
        end
        api.new()
        f.flush()
        respond_fast(f.request("agency/backends"), { defaultBackendId = "codex-acp", backends = { { id = "codex-acp",
            discovery = "unavailable", defaults = { modeId = "agent-full-access" }, models = {}, settings = {} } } })
        assert.is_truthy(label:find("discovery unavailable", 1, true))
        assert.are.same({ modeId = "agent-full-access" }, f.request("session/new").params._meta.agency.selection)
    end)
    it("shows cached models and the discovery failure before creation", function()
        local result, labels = choices(), {}
        result.backends[1].discovery = "cached"
        result.backends[1].discoveryError = "Provider discovery timed out"
        vim.ui.select = function(items, opts, callback)
            if opts.prompt:find("Agency model", 1, true) then
                assert.is_truthy(opts.prompt:find("Provider discovery timed out", 1, true))
                for _, item in ipairs(items) do labels[#labels + 1] = opts.format_item(item) end
                callback(items[2])
            else callback(items[1]) end
        end
        api.new()
        f.flush()
        respond_fast(f.request("agency/backends"), result)
        assert.is_truthy(labels[2]:find("cached", 1, true))
        assert.are.equal("model-c", f.request("session/new").params._meta.agency.selection.configValues.model)
    end)
    it("requires explicit backend choice when the configured default is unavailable", function()
        local prompt
        vim.ui.select = function(_, opts, callback) prompt = opts.prompt; callback(nil) end
        api.new()
        f.flush()
        respond_fast(f.request("agency/backends"), { defaultBackendId = "codex-acp", backends = { { id = "claude-agent-acp" } } })
        assert.are.equal("Agency backend", prompt)
        assert.are.equal(0, count("session/new"))
    end)
    it("preserves unsupported configured defaults for provider validation", function()
        local result, prompts = choices(), {}
        result.backends[1].defaults = { modelId = "model-a[high]", modeId = "agent", configValues = { reasoning_effort = "high" } }
        vim.ui.select = function(items, opts, callback)
            prompts[#prompts + 1] = opts.prompt
            callback(items[2])
        end
        api.new()
        f.flush()
        respond_fast(f.request("agency/backends"), result)
        assert.are.same({ "Agency model" }, prompts)
        assert.are.same({ modeId = "agent", configValues = { model = "model-c", reasoning_effort = "high" } },
            f.request("session/new").params._meta.agency.selection)
    end)
    local function settings()
        return {
            { id = "reasoning_effort", name = "Reasoning effort", type = "select", currentValue = "high",
                options = { { value = "low", name = "Low" }, { value = "high", name = "High" } } },
            { id = "mode", name = "Permissions", category = "mode", type = "select", currentValue = "agent-full-access",
                options = { { value = "read-only", name = "Read only" }, { value = "agent-full-access", name = "Full access" } } },
        }
    end
    for _, id in ipairs({ "reasoning_effort", "mode" }) do
        it("changes the attached agent's " .. id .. " through the native setter", function()
            f.manager.config_options:set_options(settings())
            local prompts = {}
            vim.ui.select = function(items, opts, callback)
                assert.is_false(vim.in_fast_event())
                prompts[#prompts + 1] = opts.prompt
                if opts.prompt == "Agency settings" then
                    for _, item in ipairs(items) do
                        if item.id == id then
                            assert.is_truthy(opts.format_item(item):find(id == "mode" and "Full access" or "High", 1, true))
                            callback(item); return
                        end
                    end
                else
                    assert.is_truthy(opts.format_item(items[1]):find("current", 1, true))
                    callback(items[2])
                end
            end
            vim.cmd("AgencySettings")
            f.flush()
            assert.are.equal(2, #prompts)
            local frame = f.request("session/set_config_option")
            assert.are.equal(f.manager.session_id, frame.params.sessionId)
            assert.are.equal(id, frame.params.configId)
            assert.are.equal(id == "mode" and "read-only" or "low", frame.params.value)
            local options = settings()
            for _, option in ipairs(options) do if option.id == id then option.currentValue = frame.params.value end end
            respond_fast(frame, { configOptions = options })
            for _, option in ipairs(f.manager.config_options.options) do
                if option.id == id then assert.are.equal(frame.params.value, option.currentValue) end
            end
            assert.are.equal(0, count("session/new"))
        end)
    end
    for _, stage in ipairs({ "Agency settings", "Agency Reasoning effort" }) do
        it("cancels the settings picker at " .. stage, function()
            f.manager.config_options:set_options(settings())
            vim.ui.select = function(items, opts, callback) callback(opts.prompt ~= stage and items[1] or nil) end
            api.settings(); f.flush()
            assert.are.equal(0, count("session/set_config_option"))
            assert.are.equal(0, count("session/new"))
        end)
        for _, action in ipairs({ "current", "reload", "configuration" }) do
            it("discards a pending " .. stage .. " callback after " .. action, function()
                f.manager.config_options:set_options(settings())
                local pending
                vim.ui.select = function(items, opts, callback)
                    if opts.prompt == stage then pending = function() callback(items[2]) end else callback(items[1]) end
                end
                api.settings(); f.flush()
                assert.is_function(pending)
                if action == "current" then api.current()
                elseif action == "reload" then f.manager:load_acp_session(f.manager.session_id, "Reloaded")
                else local options = settings(); options[1].currentValue = "low"; f.manager.config_options:set_options(options) end
                pending(); f.flush()
                assert.are.equal(0, count("session/set_config_option"))
            end)
        end
    end
    it("does not send a setter when the current value is chosen", function()
        f.manager.config_options:set_options(settings())
        api.settings(); f.flush()
        assert.are.equal(0, count("session/set_config_option"))
    end)
    it("preserves boolean values and grouped choices", function()
        f.manager.config_options:set_options({
            { id = "toggle", name = "Toggle", type = "boolean", currentValue = true },
            { id = "grouped", name = "Grouped", type = "select", currentValue = "a",
                options = { { group = "Group", options = { { value = "a", name = "A" }, { value = "b", name = "B" } } } } },
        })
        vim.ui.select = function(items, opts, callback) callback(opts.prompt == "Agency settings" and items[1] or items[2]) end
        api.settings(); f.flush()
        local frame = f.request("session/set_config_option")
        assert.are.equal("toggle", frame.params.configId)
        assert.is_false(frame.params.value)
        respond_fast(frame, {})
        vim.ui.select = function(items, _, callback) callback(items[2]) end
        api.settings(); f.flush()
        frame = f.request("session/set_config_option")
        assert.are.equal("grouped", frame.params.configId)
        assert.are.equal("b", frame.params.value)
    end)
    it("uses legacy modes when config options are unavailable", function()
        f.manager.config_options:set_legacy_modes({ currentModeId = "normal",
            availableModes = { { id = "normal", name = "Normal" }, { id = "review", name = "Review" } } })
        vim.ui.select = function(items, opts, callback) callback(opts.prompt == "Agency settings" and items[1] or items[2]) end
        api.settings(); f.flush()
        assert.are.equal("review", f.request("session/set_mode").params.modeId)
        assert.are.equal(0, count("session/set_config_option"))
    end)
    it("does not create an agent when settings are requested without an attachment", function()
        api.detach(); api.settings(); f.flush()
        assert.are.equal(0, count("session/new"))
        assert.are.same({ "not ready" }, notifications)
    end)
    it("reports a provider with no adjustable settings", function()
        api.settings(); f.flush()
        assert.are.same({ "This agent has no adjustable settings" }, notifications)
        assert.are.equal(0, count("session/new"))
    end)
    for _, stage in ipairs({ "confirmation", "import" }) do
        for _, action in ipairs({ "new session", "close tab" }) do
            it("discards saved-history " .. stage .. " after " .. action, function()
                local picker, confirmation, restores = nil, nil, 0
                local origin = vim.api.nvim_get_current_tabpage()
                if action == "close tab" then vim.cmd("tabnew"); vim.api.nvim_set_current_tabpage(origin) end
                _G.Snacks = { picker = function(opts) picker = opts end }
                vim.ui.select = function(_, _, callback) confirmation = callback end
                api.restore = function() restores = restores + 1 end
                require("sodium.agentic_sessions").show_picker(f.manager, { lifecycle = api })
                f.flush()
                respond_fast(f.request("session/list"), { sessions = {} })
                respond_fast(f.request("agency/backends"), { backends = { { id = "codex-acp" } } })
                respond_fast(f.request("agency/native_sessions"), { sessions = {
                    { backendId = "codex-acp", nativeSessionId = "saved-native", cwd = vim.fn.getcwd(), title = "Saved" } } })
                assert.is_not_nil(picker)
                picker.confirm({ close = function() end }, picker.items[1])
                if stage == "import" then confirmation("Restore"); f.flush(); assert.are.equal(1, count("agency/import")) end
                if action == "new session" then api.new(); f.flush()
                else require("agentic.session_registry").destroy_session(origin); vim.cmd("tabclose!") end
                local current_tab = vim.api.nvim_get_current_tabpage()
                if stage == "confirmation" then confirmation("Restore"); f.flush()
                else respond_fast(f.request("agency/import"), { sessionId = "agency:logical" }) end
                assert.are.equal(0, restores)
                assert.are.equal(stage == "import" and 1 or 0, count("agency/import"))
                assert.are.equal(current_tab, vim.api.nvim_get_current_tabpage())
            end)
        end
    end
    it("sends backend discovery with object parameters", function()
        vim.cmd("AgencyNew")
        f.flush()
        assert.are.equal("{}", vim.json.encode(f.request("agency/backends").params))
    end)
    it("creates a single-backend session after a fast-event response", function()
        vim.cmd("AgencyNew")
        f.flush()
        respond_fast(f.request("agency/backends"), { backends = { { id = "codex-acp" } } })
        assert.are.equal(1, count("session/new"))
        assert.are.equal("codex-acp", f.request("session/new").params._meta.agency.backendId)
        assert.are.equal(0, #notifications)
    end)
    it("selects a backend on the normal event loop", function()
        local selected
        vim.ui.select = function(items, opts, callback)
            assert.is_false(vim.in_fast_event())
            if opts.prompt ~= "Agency backend" then callback(items[1]); return end
            assert.are.equal("codex-acp (default)", opts.format_item(items[1]))
            selected = items[2]
            callback(selected)
        end
        api.new()
        f.flush()
        respond_fast(f.request("agency/backends"), { defaultBackendId = "codex-acp",
            backends = { { id = "codex-acp" }, { id = "claude-agent-acp" } } })
        assert.are.equal("claude-agent-acp", selected.id)
        assert.are.equal("claude-agent-acp", f.request("session/new").params._meta.agency.backendId)
    end)
    it("reports fast-event discovery errors without creating a session", function()
        api.new()
        f.flush()
        respond_fast(f.request("agency/backends"), nil, { code = -32602, message = "Invalid parameters" })
        assert.are.same({ "Invalid parameters" }, notifications)
        assert.are.equal(0, count("session/new"))
    end)
    it("reports an empty backend inventory without creating a session", function()
        api.new()
        f.flush()
        respond_fast(f.request("agency/backends"), { backends = {} })
        assert.are.same({ "unavailable" }, notifications)
        assert.are.equal(0, count("session/new"))
    end)
    it("cancels backend selection without creating a session", function()
        vim.ui.select = function(_, _, callback) callback(nil) end
        api.new()
        f.flush()
        respond_fast(f.request("agency/backends"), { backends = { { id = "codex-acp" }, { id = "claude-agent-acp" } } })
        assert.are.equal(0, count("session/new"))
        assert.are.equal(0, #notifications)
    end)
    it("discards a discovery response after detach", function()
        api.new()
        f.flush()
        local frame = f.request("agency/backends")
        vim.cmd("AgencyDetach")
        respond_fast(frame, { backends = { { id = "codex-acp" } } })
        assert.are.equal(0, count("session/new"))
        assert.are.equal(0, #notifications)
    end)
    it("discards a discovery response after the originating tab closes", function()
        vim.cmd("tabnew")
        local tab = vim.api.nvim_get_current_tabpage()
        api.new()
        f.flush()
        local frame = f.request("agency/backends")
        vim.api.nvim_set_current_tabpage(tab)
        vim.cmd("tabclose!")
        assert.is_false(vim.api.nvim_tabpage_is_valid(tab))
        f.flush()
        local created = count("session/new")
        respond_fast(frame, { backends = { { id = "codex-acp" } } })
        assert.are.equal(created, count("session/new"))
        assert.are.equal(0, #notifications)
    end)
    it("discards a backend choice after another operation supersedes it", function()
        local choose
        vim.ui.select = function(_, _, callback) choose = callback end
        api.new()
        f.flush()
        respond_fast(f.request("agency/backends"), { backends = { { id = "codex-acp" }, { id = "claude-agent-acp" } } })
        vim.cmd("AgencyDetach")
        choose({ id = "codex-acp" })
        f.flush()
        assert.are.equal(0, count("session/new"))
    end)
    it("lists saved sessions with object parameters through fast-event callbacks", function()
        local picker
        _G.Snacks = { picker = function(opts)
            assert.is_false(vim.in_fast_event())
            picker = opts
        end }
        require("sodium.agentic_sessions").show_picker(f.manager)
        f.flush()
        local frame = f.request("session/list")
        assert.are.equal("{}", vim.json.encode(frame.params))
        respond_fast(frame, { sessions = { { sessionId = f.manager.session_id, cwd = vim.fn.getcwd(),
            _meta = { agency = { backendId = "codex-acp", phase = "ready" } } } } })
        frame = f.request("agency/backends")
        assert.are.equal("{}", vim.json.encode(frame.params))
        respond_fast(frame, { backends = { { id = "codex-acp" } } })
        frame = f.request("agency/native_sessions")
        assert.are.equal("{}", vim.json.encode(frame.params))
        respond_fast(frame, { sessions = {} })
        assert.are.equal("Select session to restore", picker.title)
        assert.are.equal(f.manager.session_id, picker.items[1].session_id)
    end)
    it("restores imported native history on the normal event loop", function()
        local picker, restored
        _G.Snacks = { picker = function(opts) picker = opts end }
        vim.ui.select = function(_, _, callback) callback("Restore") end
        require("sodium.agentic_sessions").show_picker(f.manager, { lifecycle = {
            uuid = function() return require("fixtures.agency_control").id(600) end,
            restore = function(id)
                assert.is_false(vim.in_fast_event())
                assert.is_true(vim.api.nvim_tabpage_is_valid(vim.api.nvim_get_current_tabpage()))
                restored = id
            end,
        } })
        f.flush()
        respond_fast(f.request("session/list"), { sessions = {} })
        respond_fast(f.request("agency/backends"), { backends = { { id = "codex-acp" } } })
        respond_fast(f.request("agency/native_sessions"), { sessions = { { backendId = "codex-acp",
            nativeSessionId = "saved-native", cwd = vim.fn.getcwd(), title = "Saved" } } })
        picker.confirm({ close = function() end }, picker.items[1])
        f.flush()
        respond_fast(f.request("agency/import"), { sessionId = "agency:imported" })
        assert.are.equal("imported", restored)
    end)
    it("returns and toggles the existing native manager", function()
        local result
        api.current(function(err, manager) assert.is_nil(err); result = manager end)
        assert.are.equal(f.manager, result)
        assert.are.equal(f.manager, api.view_for_buffer(f.manager.widget.buf_nrs.chat))
        for _, frame in ipairs(f.frames) do assert.is_not.equal("session/new", frame.method) end
    end)
    it("routes the configured Agency mappings and saved-session shortcut", function()
        local module = require("sodium.agency")
        local native = require("agentic")
        local restore = native.restore_session
        local called, saved = {}, {}
        local expected = { ["<leader>ac"] = { "current" }, ["<leader>an"] = { "new" }, ["<leader>ae"] = { "settings" },
            ["<leader>af"] = { "roster" }, ["<leader>as"] = { "stop" }, ["<leader>ao"] = { "open" },
            ["<leader>aa"] = { "add_context" }, ["<leader>ad"] = { "add_diagnostics", "line" },
            ["<leader>aD"] = { "add_diagnostics", "buffer" }, ["<leader>ar"] = { "restore_session" } }
        for _, method in ipairs({ "current", "new", "settings", "roster", "stop", "open", "add_context", "add_diagnostics" }) do
            saved[method] = module[method]
            module[method] = function(value) called = { method, value } end
        end
        native.restore_session = function() called = { "restore_session" } end
        local ok, err = pcall(function()
            local seen = {}
            for _, mapping in ipairs(require("sodium.plugins.agentic").keys) do
                if expected[mapping[1]] then
                    mapping[2]()
                    assert.are.same(expected[mapping[1]], called)
                    seen[mapping[1]] = true
                end
            end
            assert.are.equal(10, vim.tbl_count(seen))
        end)
        for method, original in pairs(saved) do module[method] = original end
        native.restore_session = restore
        assert.is_true(ok, err)
    end)
    for _, confirm in ipairs({ true, false }) do
        it(confirm and "opens a project file without altering the active agent" or "cancels project selection without altering the active agent", function()
            local system, options = vim.system, nil
            local file = vim.fn.tempname() .. ".md"
            vim.fn.writefile({ "# Project", "Project content" }, file)
            local buffer = vim.api.nvim_get_current_buf()
            local binding = vim.deepcopy(f.manager._agency_binding)
            local frames = #f.frames
            vim.system = function(argv, opts, callback)
                assert.are.equal("list-projects", argv[2])
                assert.is_true(opts.text)
                callback({ code = 0, stdout = "test-project\tTest Project\tactive\n" })
            end
            _G.Snacks = { picker = function(value) options = value end }
            local ok, err = pcall(function()
                for _, mapping in ipairs(require("sodium.plugins.agentic").keys) do
                    if mapping[1] == "<leader>ap" then mapping[2]() end
                end
                f.flush()
                assert.are.equal("Projects", options.title)
                assert.are.equal("test-project", options.items[1].slug)
                assert.is_truthy(options.items[1].file:match("/test%-project/project%.md$"))
                options.items[1].file = file
                options.confirm({ close = function() end }, confirm and options.items[1] or nil)
                f.flush()
                if confirm then
                    assert.are.equal(vim.fn.resolve(file), vim.fn.resolve(vim.api.nvim_buf_get_name(0)))
                    assert.are.same({ "# Project", "Project content" }, vim.api.nvim_buf_get_lines(0, 0, -1, false))
                else assert.are.equal(buffer, vim.api.nvim_get_current_buf()) end
                assert.are.equal(frames, #f.frames)
                assert.are.same(binding, f.manager._agency_binding)
                assert.are.equal(f.manager, require("agentic.session_registry").sessions[vim.api.nvim_get_current_tabpage()])
            end)
            vim.system = system
            local opened = vim.fn.bufnr(file)
            if opened ~= -1 then vim.api.nvim_buf_delete(opened, { force = true }) end
            vim.fn.delete(file)
            assert.is_true(ok, err)
        end)
    end
    for _, race in ipairs({ "exited", "provider restarted", "Handler restarted" }) do
        it("rejects an active-picker attachment when the selected agent " .. race, function()
            local row = vim.deepcopy(f.row)
            if race == "provider restarted" then row.record.launch.providerGeneration = require("fixtures.agency_control").id(99)
            elseif race == "Handler restarted" then row.record.launch.handlerGeneration = require("fixtures.agency_control").id(99) end
            api.page = function(_, callback)
                callback(nil, { agents = race == "exited" and {} or { row } })
            end
            local frames = #f.frames
            api.attach(f.row.record.definition.agentId, nil, f.row)
            f.flush()
            assert.are.same({ race == "exited" and "unavailable" or "stale provider" }, notifications)
            assert.are.equal(frames, #f.frames)
            assert.are.equal("agency:" .. f.row.record.definition.agentId, f.manager.session_id)
        end)
    end
    it("rejects invalid attachment and restoration identifiers without control requests", function()
        vim.cmd("AgencyAttach invalid")
        vim.cmd("AgencyRestore invalid")
        assert.are.same({ "usage", "usage" }, notifications)
        assert.are.equal(0, count("session/new"))
    end)
    it("adds only current-line diagnostics without submitting a prompt", function()
        local buffer = vim.api.nvim_create_buf(false, true)
        vim.api.nvim_set_current_win(f.manager.widget:find_first_non_widget_window())
        vim.api.nvim_set_current_buf(buffer)
        vim.api.nvim_buf_set_lines(buffer, 0, -1, false, { "first", "second" })
        local ns = vim.api.nvim_create_namespace("agency-command-diagnostics")
        vim.diagnostic.set(ns, buffer, { { lnum = 0, col = 0, message = "first diagnostic" },
            { lnum = 1, col = 0, message = "second diagnostic" } })
        vim.api.nvim_win_set_cursor(0, { 2, 0 })
        api.add_diagnostics("line")
        assert.are.equal(1, #f.manager.diagnostics_list:get_diagnostics())
        assert.are.equal("second diagnostic", f.manager.diagnostics_list:get_diagnostics()[1].message)
        assert.are.equal(0, count("session/prompt"))
        vim.api.nvim_buf_delete(buffer, { force = true })
    end)
    it("adds all buffer diagnostics without submitting a prompt", function()
        local buffer = vim.api.nvim_create_buf(false, true)
        vim.api.nvim_set_current_win(f.manager.widget:find_first_non_widget_window())
        vim.api.nvim_set_current_buf(buffer)
        vim.api.nvim_buf_set_lines(buffer, 0, -1, false, { "first", "second" })
        local ns = vim.api.nvim_create_namespace("agency-command-diagnostics")
        vim.diagnostic.set(ns, buffer, { { lnum = 0, col = 0, message = "first diagnostic" },
            { lnum = 1, col = 0, message = "second diagnostic" } })
        api.add_diagnostics("buffer")
        assert.are.equal(2, #f.manager.diagnostics_list:get_diagnostics())
        assert.are.equal(0, count("session/prompt"))
        vim.api.nvim_buf_delete(buffer, { force = true })
    end)
    it("captures context before native widget focus", function()
        local buffer = vim.api.nvim_create_buf(false, true)
        vim.api.nvim_set_current_win(f.manager.widget:find_first_non_widget_window())
        vim.api.nvim_set_current_buf(buffer)
        vim.api.nvim_buf_set_lines(buffer, 0, -1, false, { "captured before focus" })
        api.add_context()
        assert.are.same({ "captured before focus" }, f.manager.code_selection:get_selections()[1].lines)
        vim.api.nvim_buf_delete(buffer, { force = true })
    end)
    it("submits through native ACP and accepts annotations only on Handler admission", function()
        local accepted, outcome = 0
        api.annotations = function() return { { text = "annotation" } } end
        api.accept_annotations = function() accepted = accepted + 1 end
        assert.is_true(api.submit_text("review", { annotations = true }, function(value) outcome = value end))
        local prompt = f.request("session/prompt")
        assert.are.equal("annotation", prompt.params.prompt[#prompt.params.prompt].text)
        assert.are.equal(0, accepted)
        f.state(prompt.params._meta.agency.submissionId, "running")
        assert.are.equal(1, accepted)
        assert.are.equal("accepted", outcome.state)
    end)
    it("rejects busy annotation submission without clearing or staging it", function()
        local outcome
        api.annotations = function() return { { text = "keep" } } end
        f.state("other-turn", "running")
        assert.is_false(api.submit_text("review", { annotations = true }, function(value) outcome = value end))
        assert.are.equal("rejected", outcome.state)
        assert.are.equal(0, #(f.manager._agency_pending_context or {}))
    end)
    it("detaches native views without cancelling or stopping providers", function()
        f.state("shared-turn", "running")
        api.detach()
        assert.is_true(f.manager._agency_destroyed)
        for _, frame in ipairs(f.frames) do assert.is_not.equal("session/cancel", frame.method) end
    end)
end)