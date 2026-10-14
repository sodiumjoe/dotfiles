package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
local fixture = require("fixtures.agency_control")
describe("Agency owner picker", function()
    it("reads local ACP and owners independently and distinguishes equal UUIDs on different hosts", function()
        local original, opts, tick, callbacks, entered = Snacks, nil, nil, {}, {}
        Snacks = { picker = function(options)
            opts = options
            return { opts = options, find = function() end, close = function() options.on_close() end }
        end }
        local row = fixture.agent(fixture.target_a)
        local picker = require("sodium.agency.picker").open({ snapshot = function() end, notify = function() end,
            page = function(_, cb) callbacks.page = cb end, roster = function(cb) callbacks.roster = cb end,
            enter_remote = function(ref) entered[#entered + 1] = ref end,
            timer_factory = function() return { start = function(_, _, _, cb) tick = cb end, stop = function() end, close = function() end } end })
        callbacks.page(nil, { agents = { row }, issues = {}, handlerGeneration = fixture.id(2) })
        assert.are.equal(1, #opts.items)
        local remote = vim.deepcopy(row); remote.record.definition.hostId = string.rep("b", 64)
        callbacks.roster(nil, { state = "roster", localHostId = string.rep("a", 64), hosts = {
            { hostId = string.rep("a", 64), hostname = "local", state = "available", value = { handlerGeneration = fixture.id(2), agents = { row }, issues = {} } },
            { hostId = string.rep("b", 64), hostname = "worker", state = "available", value = { handlerGeneration = fixture.id(2), agents = { remote }, issues = {} } },
            { hostId = string.rep("c", 64), hostname = "missing", state = "unavailable", code = "HOST_UNAVAILABLE" },
        } })
        assert.are.equal(3, #opts.items)
        assert.are_not.equal(opts.items[1].id, opts.items[2].id)
        assert.are.same({ hostId = string.rep("b", 64), target = fixture.target_a }, opts.items[2].remote_ref)
        opts.confirm(picker, opts.items[2]); vim.wait(100, function() return #entered > 0 end)
        assert.are.equal(1, #entered)
        tick(); assert.are.equal(3, #opts.items)
        Snacks = original
    end)
end)