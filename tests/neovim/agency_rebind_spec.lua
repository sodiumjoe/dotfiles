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

    local function detaches(start)
        local found = {}
        for index = start + 1, #f.frames do
            if f.frames[index].method == "agency/detach" then found[#found + 1] = f.frames[index].params.sessionId end
        end
        return found
    end

    it("reconnects the client once and reattaches a session bound to an earlier run into a new view", function()
        local key, manager, before = f.manager.session_key, f.manager, loads()
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
        local target = Registry.find_by_acp_session_id(manager.session_id, f.client)
        assert.is_not.equal(manager, target)
        answer_load(moved)
        assert.is_true(vim.wait(300, function() return state.summary ~= nil end, 5))
        assert.is_nil(Registry.get(key))
        assert.are.equal(target, Registry.current())
        assert.is_true(target.widget:is_open())
        assert.are.same(moved, target._agency_binding)
        assert.are.equal(1, state.summary.rebound)
        assert.are.same({}, detaches(0))
        assert.are.equal(1, #vim.api.nvim_list_tabpages())
    end)

    it("leaves a session already bound to the live run alone", function()
        local before = loads()
        local summary = run({ f.row }, { reconnect = function(done) done() end })
        assert.are.equal(1, summary.rebound)
        assert.are.equal(before, loads())
        assert.are.equal(f.manager, Registry.current())
    end)

    it("finishes with a timeout when the client never reconnects", function()
        local summary
        require("sodium.agency.rebind").run({ f.row }, { timeout_ms = 50, reconnect = function() end }, function(value) summary = value end)
        assert.is_true(vim.wait(500, function() return summary ~= nil end, 5))
        assert.is_true(summary.timed_out)
        assert.are.equal(0, summary.rebound)
    end)

    it("reports a session whose agent is stopped without loading it", function()
        local key, manager, before = f.manager.session_key, f.manager, loads()
        local row = control.agent(control.target_a)
        row.live, row.record.launch, row.record.phase = false, vim.NIL, "stopped"
        local summary = run({ row }, { reconnect = function(done) done() end })
        assert.are.same({ { control.target_a.agentId }, {} }, { summary.stopped, summary.missing })
        assert.are.equal(before, loads())
        assert.are.equal(manager, Registry.get(key))
    end)

    it("keeps a session whose agent is missing and reports it", function()
        local key, manager, before = f.manager.session_key, f.manager, loads()
        local summary = run({}, { reconnect = function(done) done() end })
        assert.are.same({ control.target_a.agentId }, summary.missing)
        assert.are.equal(before, loads())
        assert.are.equal(manager, Registry.get(key))
    end)

    it("reports a failing reattach and still calls back once", function()
        local Rebind = require("sodium.agency.rebind")
        local original, calls = Rebind.reattach, 0
        Rebind.reattach = function() error("boom") end
        local _, row = moved_row()
        local ok, summary = pcall(function()
            local value
            Rebind.run({ row }, { reconnect = function(done) done() end }, function(v)
                calls = calls + 1
                value = v
            end)
            assert.is_true(vim.wait(300, function() return value ~= nil end, 5))
            return value
        end)
        Rebind.reattach = original
        assert.is_true(ok, summary)
        f.flush()
        assert.are.equal(1, calls)
        assert.are.equal(0, summary.rebound)
        assert.are.equal(1, #summary.failed)
        assert.are.equal(control.target_a.agentId, summary.failed[1].agentId)
        assert.is_truthy(summary.failed[1].error:find("boom", 1, true))
        assert.are.equal(f.manager, Registry.current())
    end)

    it("reports a session whose reattach load fails and keeps the old view", function()
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
        assert.are.same({ f.manager }, Registry.list())
    end)

    it("reports a session whose connection ends before its reattach load answers", function()
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

    it("rolls back a pending reattach whose source was closed, detaching only once", function()
        local source, id = f.manager, f.manager.session_id
        local moved, row = moved_row()
        local before = loads()
        local target = require("sodium.agency.rebind").reattach(source, row)
        f.flush()
        assert.are.equal(before + 1, loads())
        assert.is_not.equal(source, target)
        local start = #f.frames
        Registry.destroy(source.session_key)
        f.flush()
        assert.are.same({}, detaches(start))
        answer_load(moved)
        assert.is_true(target._destroyed)
        assert.are.same({}, Registry.list())
        assert.are.same({ id }, detaches(start))
        assert.is_nil(f.client.subscribers[id])
    end)

    it("opens a session during its pending reattach without loading or showing the target", function()
        local source = f.manager
        local _, row = moved_row()
        source._agency_unavailable = true
        local target = require("sodium.agency.rebind").reattach(source, row)
        f.flush()
        local before = loads()
        local opened = require("sodium.agency").open(row)
        f.flush()
        assert.are.equal(target, opened)
        assert.are.equal(before, loads())
        assert.is_false(target.widget:is_open())
        assert.are.equal(source, Registry.current())
        source._agency_unavailable = false
        assert.are.equal(source, require("sodium.agency").open(f.row))
        assert.are.equal(before, loads())
        assert.is_false(target.widget:is_open())
    end)
end)