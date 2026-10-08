package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
local f = require("fixtures.agency_control")
local function remote_row(connected)
    return { agent = { hostId = string.rep("b", 64), agentId = f.target_b.agentId }, execution = vim.tbl_extend("force", f.target_b, { handlerGeneration = f.id(20), hostId = string.rep("b", 64) }),
        inventoryId = f.id(8), hostname = "devbox-b", cwd = "/work", settings = { configValues = { model = "model-b" } },
        backendId = "codex-acp", title = "Worker task", providerPhase = "ready", connectivity = connected and "connected" or "disconnected",
        observedAt = 1000, dispatchable = connected, depth = 1, parent = { hostId = string.rep("a", 64), agentId = f.target_a.agentId }, attempt = { state = "completed", description = "Implement task" }, permissionCount = 2 }
end
describe("Agency Bureau picker", function()
    local original, options, picker, update, unavailable, calls, closed
    before_each(function()
        original, calls, closed = _G.Snacks, {}, 0
        _G.Snacks = { picker = function(opts)
            options = opts; picker = { opts = opts, find = function() end, close = function() opts.on_close() end,
                current = function() return opts.items[1] end }; return picker
        end }
    end)
    after_each(function() if options then options.on_close() end; _G.Snacks = original; vim.cmd("only") end)
    local function open()
        return require("sodium.agency.picker").open({ page = function(_, cb) cb(nil, { handlerGeneration = f.target_a.handlerGeneration, agents = { f.agent(f.target_a) }, issues = {} }) end,
            snapshot = function() end, notify = function() end, attach = function() calls[#calls + 1] = "attach" end,
            stop = function() calls[#calls + 1] = "stop" end, enter_remote = function(ref) calls[#calls + 1] = ref end,
            watch_roster = function(success, failure) update, unavailable = success, failure; return { close = function() closed = closed + 1 end } end,
            timer_factory = function() return { start = function() end, stop = function() end, close = function() end } end })
    end
    it("selects the exact remote execution after teardown without altering local splits", function()
        vim.cmd("vsplit"); local before = vim.fn.winlayout(); open()
        update({ agents = { remote_row(true) }, hosts = {} }); assert.are.equal(1, #options.items)
        assert.is_truthy(options.items[1].text:find("devbox%-b")); assert.is_truthy(table.concat(options.items[1].preview, " "):find("completed"))
        options.confirm(picker, options.items[1]); vim.wait(1000, function() return #calls == 1 end)
        assert.are.same(before, vim.fn.winlayout()); assert.are.equal(f.id(20), calls[1].target.handlerGeneration)
        assert.are.equal(f.target_b.agentId, calls[1].target.agentId); assert.are.equal(1, closed)
    end)
    it("disconnected rows cannot enter or stop providers", function()
        open(); update({ agents = { remote_row(false) }, hosts = {} })
        options.confirm(picker, options.items[1]); options.actions.stop(picker)
        assert.are.equal(0, #calls); assert.are.equal(0, closed)
    end)
    it("stream loss removes remote authority and displays local fallback", function()
        open(); update({ agents = { remote_row(true) }, hosts = {} }); unavailable("BUREAU_UNAVAILABLE")
        assert.is_truthy(options.items[1].text:find("Bureau unavailable", 1, true)); assert.are.equal(2, #options.items)
        options.confirm(picker, options.items[1]); assert.are.equal(0, #calls)
        options.on_close(); update({ agents = { remote_row(true) }, hosts = {} }); assert.are.equal(2, #options.items)
    end)
end)