package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
local f = require("fixtures.agency_control")
local remote = require("sodium.agency.remote")
local function row()
    return { hostId = string.rep("b", 64), target = f.target_b }
end
describe("Agency exact remote entry", function()
    it("opens the selected identity and launches SSH without changing editor windows", function()
        local calls, launches, notices = {}, {}, {}
        local api = remote.new({ client = { command = function(argv, _, cb) calls[#calls + 1] = { argv = argv, callback = cb } end },
            uuid = function() return f.id(9) end, launch = function(argv) launches[#launches + 1] = argv end,
            notify = function(value) notices[#notices + 1] = value end, control_path = function() return "/fixture/%C" end })
        vim.cmd("vsplit"); local before = vim.fn.winlayout()
        api.enter(row())
        assert.are.same({ commandId = f.id(9), hostId = row().hostId, target = row().target }, vim.json.decode(calls[1].argv[4]))
        assert.are.same({ "entry", "open" }, { calls[1].argv[1], calls[1].argv[2] })
        calls[1].callback(nil, { result = { receipt = { commandId = f.id(9), ref = row(), state = "opened", editor = { editorId = f.id(7), session = "entry", pane = "%1", tmuxSocketPath = "/fixture/tmux.sock" } },
            enrollment = { hostId = string.rep("b", 64), hostname = "devbox-b" } } })
        assert.are.same(before, vim.fn.winlayout()); assert.are.equal(1, #launches)
        assert.is_truthy(launches[1][#launches[1]]:find("^exec 'agy' 'internal%-runtime%-entry' "))
        assert.is_nil(launches[1][#launches[1]]:find(" -lc ", 1, true))
        assert.are.equal("ssh", launches[1][1]); assert.is_truthy(table.concat(launches[1], " "):find(f.id(9), 1, true))
        assert.is_truthy(table.concat(launches[1], " "):find("internal-runtime-entry", 1, true));
        assert.is_truthy(table.concat(launches[1], " "):find(row().hostId, 1, true));
        assert.is_nil(table.concat(launches[1], " "):find("--remote%-expr")); assert.are.equal(0, #notices)
        vim.cmd("only")
    end)
    it("rejects substituted identity and stale intent before launching SSH", function()
        local callback, launches, notices = nil, 0, {}
        local api = remote.new({ client = { command = function(_, _, cb) callback = cb end }, uuid = function() return f.id(9) end,
            launch = function() launches = launches + 1 end, notify = function(value) notices[#notices + 1] = value end,
            control_path = function() return "/fixture/%C" end })
        api.enter(row()); callback(nil, { result = { receipt = { commandId = f.id(9), ref = row(), state = "opened", editor = { editorId = f.id(7), session = "entry", pane = "%1", tmuxSocketPath = "/fixture/tmux.sock" } },
            enrollment = { hostId = string.rep("a", 64), hostname = "replacement" } } })
        assert.are.equal(0, launches); assert.are.equal(1, #notices)
    end)
end)

describe("Agency uncertain runtime entry", function()
    for _, state in ipairs({ "uncertain", "stale", "OUTCOME_UNKNOWN" }) do
        it("keeps " .. state .. " inspectable without launching a terminal", function()
            local notices, count, callback = {}, 0, nil
            local api = remote.new({ client = { command = function(_, _, cb) callback = cb end }, uuid = function() return f.id(9) end,
                launch = function() count = count + 1 end, notify = function(value) notices[#notices + 1] = value end })
            api.enter(row())
            if state == "OUTCOME_UNKNOWN" then callback({ code = state, message = "lost" })
            else callback(nil, { result = { receipt = { commandId = f.id(9), ref = row(), state = state }, enrollment = {} } }) end
            assert.are.equal(0, count); assert.are.equal(1, #notices)
            assert.is_truthy(notices[1]:find(f.id(9), 1, true)); assert.is_truthy(notices[1]:find(row().hostId, 1, true))
        end)
    end
    it("binds and inspects the shared editor without a task client", function()
        local tab = vim.api.nvim_get_current_tabpage()
        local registry, original = require("agentic.session_registry"), package.loaded["sodium.agency"]
        local manager = { _agency_binding = f.target_b }
        local saved = registry.sessions[tab]; registry.sessions[tab] = manager
        package.loaded["sodium.agency"] = { setup = function() return { attach = function(_, cb) cb(nil, manager) end } end }
        local value = { editorId = f.id(7), target = f.target_b }
        assert.is_true(remote.bind(value)); assert.are.same(value, vim.json.decode(remote.status(value)))
        assert.are.equal("null", remote.status({ editorId = f.id(8), target = f.target_b }))
        registry.sessions[tab] = saved; package.loaded["sodium.agency"] = original
    end)
end)