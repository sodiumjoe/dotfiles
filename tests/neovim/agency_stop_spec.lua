package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path

describe("Agency stop view cleanup", function()
    local f, transport, api, Registry, notifications, confirmed
    before_each(function()
        f = require("fixtures.agency_native").new()
        transport = require("fixtures.agency_control").operations()
        Registry = require("agentic.session_registry")
        package.loaded["sodium.agency"] = nil
        notifications, confirmed = {}, true
        api = require("sodium.agency").setup({
            client = { command = function(argv, options, callback)
                transport.calls[#transport.calls + 1] = { argv = argv, options = options, callback = callback }
            end },
            request = require("fixtures.agency_control").requests(transport.calls),
            confirm_stop = function(_, callback) callback(confirmed) end,
            notify = function(value) notifications[#notifications + 1] = value end,
        })
    end)
    after_each(function() f.close() end)

    local function stop_key()
        for _, mapping in ipairs(require("sodium.plugins.agentic").keys) do
            if mapping[1] == "<leader>as" then mapping[2](); return end
        end
        error("missing stop mapping")
    end

    local function stopped(target)
        local agentId = (target or require("fixtures.agency_control").target_a).agentId
        assert.are.equal("agency/stop", transport.pending("stop").method)
        assert.is_true(vim.tbl_contains(transport.pending("stop").argv, agentId))
        transport.answer("stop", transport.reply(target or require("fixtures.agency_control").target_a, false))
        f.flush()
    end

    it("destroys the stopped session and lets current find a new agent", function()
        local key = f.manager.session_key
        local buffers, windows = vim.deepcopy(f.manager.widget.buf_nrs), vim.deepcopy(f.manager.widget.win_nrs)
        stop_key()
        assert.is_true(f.manager.widget:is_open())
        stopped()
        assert.is_nil(Registry.get(key))
        assert.is_true(f.manager._destroyed)
        for _, buffer in pairs(buffers) do assert.is_false(vim.api.nvim_buf_is_valid(buffer)) end
        for _, window in pairs(windows) do assert.is_false(vim.api.nvim_win_is_valid(window)) end
        assert.is_nil(f.client.subscribers["agency:" .. f.row.record.definition.agentId])
        for _, frame in ipairs(f.frames) do assert.is_not.equal("session/cancel", frame.method) end
        api.current()
        transport.answer("agents", require("fixtures.agency_control").roster({}))
        f.flush()
        assert.is_nil(Registry.get(key))
        assert.is_not_nil(f.request("session/new"))
    end)

    for _, shutdown in ipairs({ "unavailable", "disconnected" }) do
        it("destroys the stopped session after provider " .. shutdown .. " arrives first", function()
            local key = f.manager.session_key
            local buffers, windows = vim.deepcopy(f.manager.widget.buf_nrs), vim.deepcopy(f.manager.widget.win_nrs)
            stop_key()
            if shutdown == "unavailable" then f.state(nil, "unavailable")
            else f.client:_set_state("disconnected"); f.flush() end
            assert.is_true(f.manager.widget:is_open())
            stopped()
            assert.is_nil(Registry.get(key))
            for _, buffer in pairs(buffers) do assert.is_false(vim.api.nvim_buf_is_valid(buffer)) end
            for _, window in pairs(windows) do assert.is_false(vim.api.nvim_win_is_valid(window)) end
        end)
    end

    it("keeps the session when stop confirmation is cancelled", function()
        confirmed = false
        stop_key()
        assert.are.equal(f.manager, Registry.get(f.manager.session_key))
        assert.is_true(f.manager.widget:is_open())
        assert.is_nil(transport.pending("stop"))
        assert.are.equal(0, #notifications)
    end)

    it("keeps the session when stop fails", function()
        stop_key()
        transport.answer("stop", nil, { code = "UNAVAILABLE", message = "unavailable" })
        assert.are.equal(f.manager, Registry.get(f.manager.session_key))
        assert.is_true(f.manager.widget:is_open())
        assert.are.same({ "unavailable" }, notifications)
    end)

    it("keeps the attached session when stopping another roster agent", function()
        local target = require("fixtures.agency_control").target_b
        api.stop(require("fixtures.agency_control").agent(target))
        stopped(target)
        assert.are.equal(f.manager, Registry.get(f.manager.session_key))
        assert.is_true(f.manager.widget:is_open())
    end)

    local function answer(method, target)
        local frame = f.request(method)
        f.client:_handle_message({ id = frame.id, result = { sessionId = "agency:" .. target.agentId,
            _meta = { agency = { version = 1, binding = target, backendId = "codex-acp",
                configuration = { configOptions = {}, availableCommands = {} } } } } })
        f.flush()
    end

    it("destroys only the stopped session while another is focused", function()
        local key, control = f.manager.session_key, require("fixtures.agency_control")
        stop_key()
        local other = api.open(control.agent(control.target_b))
        f.flush()
        answer("session/load", control.target_b)
        assert.are.equal(other, Registry.current())
        stopped()
        assert.is_nil(Registry.get(key))
        assert.are.equal(other, Registry.get(other.session_key))
        assert.are.equal(other, Registry.current())
        assert.is_true(other.widget:is_open())
    end)

    it("keeps a replacement session bound to the same agent when the old stop completes", function()
        local key, control = f.manager.session_key, require("fixtures.agency_control")
        stop_key()
        Registry.destroy(key)
        local replacement = api.new(nil, { cwd = vim.fn.getcwd(), backend_id = "codex-acp" })
        f.flush()
        answer("session/new", control.target_a)
        assert.are.same(control.target_a, replacement._agency_binding)
        stopped()
        assert.are.equal(replacement, Registry.get(replacement.session_key))
        assert.is_true(replacement.widget:is_open())
        assert.is_falsy(replacement._destroyed)
    end)

    it("keeps a session rebound to a newer provider generation", function()
        stop_key()
        f.manager._agency_binding.providerGeneration = require("fixtures.agency_control").id(9)
        stopped()
        assert.are.equal(f.manager, Registry.get(f.manager.session_key))
        assert.is_true(f.manager.widget:is_open())
    end)
end)