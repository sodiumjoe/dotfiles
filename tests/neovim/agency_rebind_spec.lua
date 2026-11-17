package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path

describe("Agency rebind", function()
    local f, control, Registry
    before_each(function()
        f = require("fixtures.agency_native").new()
        control = require("fixtures.agency_control")
        Registry = require("agentic.session_registry")
    end)
    after_each(function() f.close() end)

    local function loads()
        local count = 0
        for _, frame in ipairs(f.frames) do if frame.method == "session/load" then count = count + 1 end end
        return count
    end
    local function answer_load(target)
        local frame = f.request("session/load")
        f.client:_handle_message({ id = frame.id, result = { sessionId = "agency:" .. target.agentId,
            _meta = { agency = { version = 1, binding = target, backendId = "codex-acp",
                configuration = { configOptions = {}, availableCommands = {} } } } } })
        f.flush()
    end
    local function start(views, opts)
        local state = {}
        require("sodium.agency.rebind").run(views, opts, function(value) state.summary = value end)
        return state
    end
    local function moved_row()
        local moved = vim.deepcopy(control.target_a)
        moved.handlerGeneration, moved.providerGeneration = control.id(20), control.id(21)
        local row = control.agent(moved)
        row.record.definition.cwd = vim.fn.getcwd()
        return moved, row
    end
    local function run(views, opts)
        local summary
        require("sodium.agency.rebind").run(views, opts, function(value) summary = value end)
        assert.is_true(vim.wait(300, function() return summary ~= nil end, 5))
        return summary
    end

    it("reconnects the client once and reloads an idle tab in place", function()
        local tab, manager, before = f.manager.tab_page_id, f.manager, loads()
        local moved, row = moved_row()
        f.client:_set_state("disconnected")
        f.flush()
        local reconnects = 0
        local state = start({ row }, { reconnect = function(done)
            reconnects = reconnects + 1
            f.client:_set_state("ready")
            done()
        end })
        assert.is_true(vim.wait(300, function() return loads() == before + 1 end, 5))
        assert.are.equal(1, reconnects)
        assert.is_nil(state.summary)
        answer_load(moved)
        assert.is_true(vim.wait(300, function() return state.summary ~= nil end, 5))
        assert.are.equal(manager, Registry.sessions[tab])
        assert.are.same(moved, manager._agency_binding)
        assert.are.equal(1, state.summary.rebound)
        assert.are.equal(1, #vim.api.nvim_list_tabpages())
    end)

    it("defers a busy tab until its turn ends", function()
        local before = loads()
        f.state("turn-1", "running")
        local summary = run({ f.row }, { defer_busy = true, reconnect = function(done) done() end })
        assert.are.equal(1, summary.deferred)
        assert.are.equal(before, loads())
        f.state("turn-1", "idle")
        assert.is_true(vim.wait(300, function() return loads() == before + 1 end, 5))
    end)

    it("finishes with a timeout when the client never reconnects", function()
        local summary
        require("sodium.agency.rebind").run({ f.row }, { timeout_ms = 50, reconnect = function() end }, function(value) summary = value end)
        assert.is_true(vim.wait(500, function() return summary ~= nil end, 5))
        assert.is_true(summary.timed_out)
        assert.are.equal(0, summary.rebound)
    end)

    it("keeps a tab whose agent is missing and reports it", function()
        local tab, manager, before = f.manager.tab_page_id, f.manager, loads()
        local summary = run({}, { reconnect = function(done) done() end })
        assert.are.same({ control.target_a.agentId }, summary.missing)
        assert.are.equal(before, loads())
        assert.are.equal(manager, Registry.sessions[tab])
    end)

    it("rebinds a deferred tab without leaving the current tab", function()
        local before = loads()
        f.state("turn-1", "running")
        run({ f.row }, { defer_busy = true, reconnect = function(done) done() end })
        vim.cmd("tabnew")
        local current = vim.api.nvim_get_current_tabpage()
        f.state("turn-1", "idle")
        assert.is_true(vim.wait(300, function() return loads() == before + 1 end, 5))
        f.flush()
        assert.are.equal(current, vim.api.nvim_get_current_tabpage())
        assert.are.equal(2, #vim.api.nvim_list_tabpages())
    end)

    it("drops a deferred view when the tab no longer shows that agent", function()
        local before = loads()
        f.state("turn-1", "running")
        run({ f.row }, { defer_busy = true, reconnect = function(done) done() end })
        local other = vim.deepcopy(f.row)
        other.record.definition.agentId = control.id(99)
        f.manager._agency_rebind = other
        f.state("turn-1", "idle")
        f.flush()
        assert.are.equal(before, loads())
        assert.is_nil(f.manager._agency_rebind)
        assert.are.equal(1, #vim.api.nvim_list_tabpages())
    end)

    it("reports a failing open and still calls back once", function()
        local Adapter = require("sodium.agency.agentic")
        local original, calls = Adapter.open, 0
        Adapter.open = function() error("boom") end
        local current = vim.api.nvim_get_current_tabpage()
        local ok, summary = pcall(function()
            local value
            require("sodium.agency.rebind").run({ f.row }, { reconnect = function(done) done() end }, function(v)
                calls = calls + 1
                value = v
            end)
            assert.is_true(vim.wait(300, function() return value ~= nil end, 5))
            return value
        end)
        Adapter.open = original
        assert.is_true(ok, summary)
        f.flush()
        assert.are.equal(1, calls)
        assert.are.equal(0, summary.rebound)
        assert.are.equal(1, #summary.failed)
        assert.are.equal(control.target_a.agentId, summary.failed[1].agentId)
        assert.is_truthy(summary.failed[1].error:find("boom", 1, true))
        assert.are.equal(current, vim.api.nvim_get_current_tabpage())
    end)

    it("reports a tab whose session load fails", function()
        local before = loads()
        local _, row = moved_row()
        local state = start({ row }, { reconnect = function(done) done() end })
        assert.is_true(vim.wait(300, function() return loads() == before + 1 end, 5))
        local frame = f.request("session/load")
        f.client:_handle_message({ id = frame.id, error = { code = -32000, message = "agent is not known on this host" } })
        f.flush()
        assert.is_true(vim.wait(300, function() return state.summary ~= nil end, 5))
        assert.are.equal(0, state.summary.rebound)
        assert.are.same({ { agentId = control.target_a.agentId, error = "agent is not known on this host" } }, state.summary.failed)
    end)

    it("reports a tab whose connection ends before its session load answers", function()
        local before = loads()
        local _, row = moved_row()
        local again = start({ row }, { reconnect = function(done) done() end })
        assert.is_true(vim.wait(300, function() return loads() == before + 1 end, 5))
        f.client:_set_state("disconnected")
        f.flush()
        assert.is_true(vim.wait(300, function() return again.summary ~= nil end, 5))
        assert.are.equal(0, again.summary.rebound)
        assert.is_truthy(again.summary.failed[1].error:find("connection ended", 1, true))
    end)

    it("reports a load that never answers once the load timeout passes", function()
        local before = loads()
        local _, row = moved_row()
        local state = start({ row }, { load_timeout_ms = 50, reconnect = function(done) done() end })
        assert.is_true(vim.wait(500, function() return state.summary ~= nil end, 5))
        assert.are.equal(before + 1, loads())
        assert.are.equal(0, state.summary.rebound)
        assert.are.same({ { agentId = control.target_a.agentId, error = "the session load did not finish" } }, state.summary.failed)
    end)
end)