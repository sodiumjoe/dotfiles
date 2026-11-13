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
    local function run(views, opts)
        local summary
        require("sodium.agency.rebind").run(views, opts, function(value) summary = value end)
        assert.is_true(vim.wait(300, function() return summary ~= nil end, 5))
        return summary
    end

    it("reconnects the client once and reloads an idle tab in place", function()
        local tab, manager, before = f.manager.tab_page_id, f.manager, loads()
        local moved = vim.deepcopy(control.target_a)
        moved.handlerGeneration, moved.providerGeneration = control.id(20), control.id(21)
        local row = control.agent(moved)
        row.record.definition.cwd = vim.fn.getcwd()
        f.client:_set_state("disconnected")
        f.flush()
        local reconnects = 0
        local summary = run({ row }, { reconnect = function(done)
            reconnects = reconnects + 1
            f.client:_set_state("ready")
            done()
        end })
        assert.are.equal(1, reconnects)
        assert.are.equal(before + 1, loads())
        answer_load(moved)
        assert.are.equal(manager, Registry.sessions[tab])
        assert.are.same(moved, manager._agency_binding)
        assert.are.equal(1, summary.rebound)
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
end)