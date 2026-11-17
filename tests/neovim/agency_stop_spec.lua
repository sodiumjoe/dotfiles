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

    it("destroys the stopped view and lets current find a new agent", function()
        local tab = f.manager.tab_page_id
        local buffers, windows = vim.deepcopy(f.manager.widget.buf_nrs), vim.deepcopy(f.manager.widget.win_nrs)
        stop_key()
        assert.is_true(f.manager.widget:is_open())
        stopped()
        assert.is_nil(Registry.sessions[tab])
        assert.is_true(f.manager._agency_destroyed)
        for _, buffer in pairs(buffers) do assert.is_false(vim.api.nvim_buf_is_valid(buffer)) end
        for _, window in pairs(windows) do assert.is_false(vim.api.nvim_win_is_valid(window)) end
        assert.is_nil(f.client.subscribers["agency:" .. f.row.record.definition.agentId])
        for _, frame in ipairs(f.frames) do assert.is_not.equal("session/cancel", frame.method) end
        api.current()
        transport.answer("agents", require("fixtures.agency_control").roster({}))
        f.flush()
        assert.is_not.equal(f.manager, Registry.sessions[tab])
        assert.is_not_nil(f.request("session/new"))
    end)

    for _, shutdown in ipairs({ "unavailable", "disconnected" }) do
        it("destroys the stopped view after provider " .. shutdown .. " arrives first", function()
            local tab = f.manager.tab_page_id
            local buffers, windows = vim.deepcopy(f.manager.widget.buf_nrs), vim.deepcopy(f.manager.widget.win_nrs)
            stop_key()
            if shutdown == "unavailable" then f.state(nil, "unavailable")
            else f.client:_set_state("disconnected"); f.flush() end
            assert.is_true(f.manager.widget:is_open())
            stopped()
            assert.is_nil(Registry.sessions[tab])
            for _, buffer in pairs(buffers) do assert.is_false(vim.api.nvim_buf_is_valid(buffer)) end
            for _, window in pairs(windows) do assert.is_false(vim.api.nvim_win_is_valid(window)) end
        end)
    end

    it("keeps the view when stop confirmation is cancelled", function()
        confirmed = false
        stop_key()
        assert.are.equal(f.manager, Registry.sessions[f.manager.tab_page_id])
        assert.is_true(f.manager.widget:is_open())
        assert.is_nil(transport.pending("stop"))
        assert.are.equal(0, #notifications)
    end)

    it("keeps the view when stop fails", function()
        stop_key()
        transport.answer("stop", nil, { code = "UNAVAILABLE", message = "unavailable" })
        assert.are.equal(f.manager, Registry.sessions[f.manager.tab_page_id])
        assert.is_true(f.manager.widget:is_open())
        assert.are.same({ "unavailable" }, notifications)
    end)

    it("keeps the attached view when stopping another roster agent", function()
        local target = require("fixtures.agency_control").target_b
        api.stop(require("fixtures.agency_control").agent(target))
        stopped(target)
        assert.are.equal(f.manager, Registry.sessions[f.manager.tab_page_id])
        assert.is_true(f.manager.widget:is_open())
    end)

    it("cleans up the originating tab after switching to another view", function()
        local original_tab = f.manager.tab_page_id
        stop_key()
        vim.cmd("tabnew")
        local other = require("sodium.agency.agentic").open(require("fixtures.agency_control").agent(require("fixtures.agency_control").target_b))
        f.flush()
        stopped()
        assert.is_nil(Registry.sessions[original_tab])
        assert.are.equal(other, Registry.sessions[other.tab_page_id])
        assert.is_true(other.widget:is_open())
        assert.are.equal(other.tab_page_id, vim.api.nvim_get_current_tabpage())
    end)

    it("keeps a replacement view when the old stop completes", function()
        local tab = f.manager.tab_page_id
        stop_key()
        Registry.destroy_session(tab)
        local replacement = require("sodium.agency.agentic").new_session({ cwd = vim.fn.getcwd() })
        f.flush()
        stopped()
        assert.are.equal(replacement, Registry.sessions[tab])
        assert.is_true(replacement.widget:is_open())
        assert.is_false(replacement._agency_destroyed == true)
    end)

    it("keeps a view rebound to a newer provider generation", function()
        stop_key()
        f.manager._agency_binding.providerGeneration = require("fixtures.agency_control").id(9)
        stopped()
        assert.are.equal(f.manager, Registry.sessions[f.manager.tab_page_id])
        assert.is_true(f.manager.widget:is_open())
    end)

    for _, unavailable in ipairs({ false, true }) do
        it("keeps a reloaded view with the same binding, unavailable first: " .. tostring(unavailable), function()
            stop_key()
            if unavailable then f.state(nil, "unavailable") end
            f.manager:load_acp_session(f.manager.session_id, "codex-acp")
            f.flush()
            local frame = f.request("session/load")
            f.client:_handle_message({ id = frame.id, result = {
                sessionId = "agency:" .. f.row.record.definition.agentId,
                _meta = { agency = { version = 1, binding = require("fixtures.agency_control").target_a,
                    backendId = "codex-acp", configuration = { configOptions = {}, availableCommands = {} } } },
            } })
            f.flush()
            stopped()
            assert.are.equal(f.manager, Registry.sessions[f.manager.tab_page_id])
            assert.is_true(f.manager.widget:is_open())
        end)
    end
end)