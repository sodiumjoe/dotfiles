package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
local fixture = require("fixtures.agency_control")
describe("Agency owner picker", function()
    it("reads local ACP and owners independently and distinguishes equal UUIDs on different hosts", function()
        local original, opts, tick, callbacks, entered = Snacks, nil, nil, {}, {}
        Snacks = { picker = function(options)
            opts = options
            return { opts = options, find = function() end, close = function() options.on_close() end }
        end }
        local remote = require("sodium.agency.remote").new({ client = { command = function(argv, _, cb)
            callbacks.entry = cb; callbacks.argv = argv
        end }, uuid = function() return fixture.id(9) end, launch = function(argv) entered[#entered + 1] = argv end,
            control_path = function() return "/fixture/%C" end, notify = function(value) error(value) end })
        local row = fixture.agent(fixture.target_a)
        local picker = require("sodium.agency.picker").open({ snapshot = function() end, notify = function() end,
            page = function(_, cb) callbacks.page = cb end, read_roster = function(cb) callbacks.roster = cb end,
            enter_remote = remote.enter,
            timer_factory = function() return { start = function(_, _, _, cb) tick = cb end, stop = function() end, close = function() end } end })
        callbacks.page(nil, { agents = { row }, issues = {}, handlerGeneration = fixture.id(2) })
        assert.are.equal(1, #opts.items)
        local remote_row = vim.deepcopy(row); remote_row.record.definition.hostId = string.rep("b", 64)
        callbacks.roster(nil, { state = "roster", localHostId = string.rep("a", 64), hosts = {
            { hostId = string.rep("a", 64), hostname = "local", state = "available", value = { handlerGeneration = fixture.id(2), agents = { row }, issues = {} } },
            { hostId = string.rep("b", 64), hostname = "worker", state = "available", value = { handlerGeneration = fixture.id(2), agents = { remote_row }, issues = {} } },
            { hostId = string.rep("c", 64), hostname = "missing", state = "unavailable", code = "HOST_UNAVAILABLE" },
        } })
        assert.are.equal(3, #opts.items)
        assert.are_not.equal(opts.items[1].id, opts.items[2].id)
        assert.are.same({ hostId = string.rep("b", 64), target = fixture.target_a }, opts.items[2].remote_ref)
        opts.confirm(picker, opts.items[2]); vim.wait(100, function() return callbacks.entry ~= nil end)
        local ref = { hostId = string.rep("b", 64), target = fixture.target_a }
        assert.are.same({ commandId = fixture.id(9), hostId = ref.hostId, target = ref.target }, vim.json.decode(callbacks.argv[4]))
        callbacks.entry(nil, { result = { state = "entry", receipt = { commandId = fixture.id(9), ref = ref, state = "opened",
            editor = { editorId = fixture.id(8), session = "entry", pane = "%1", tmuxSocketPath = "/fixture/tmux.sock" } },
            enrollment = { hostId = ref.hostId, hostname = "worker", agyPath = "/opt/agy", loginShell = "/bin/bash" } } })
        assert.is_truthy(table.concat(entered[1], " "):find("internal-runtime-entry", 1, true))
        assert.are.equal(1, #entered)
        tick(); assert.are.equal(3, #opts.items)
        Snacks = original
    end)
end)