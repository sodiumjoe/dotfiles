package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
local f = require("fixtures.agency_control")
local remote = require("sodium.agency.remote")
local function row()
    return { inventoryId = f.id(8), hostId = string.rep("b", 64), target = f.target_b }
end
describe("Agency exact remote entry", function()
    it("prepares the selected identity and launches SSH without changing editor windows", function()
        local calls, launches, notices = {}, {}, {}
        local api = remote.new({ client = { command = function(argv, _, cb) calls[#calls + 1] = { argv = argv, callback = cb } end },
            uuid = function() return f.id(9) end, launch = function(argv) launches[#launches + 1] = argv end,
            notify = function(value) notices[#notices + 1] = value end, control_path = function() return "/fixture/%C" end })
        vim.cmd("vsplit"); local before = vim.fn.winlayout()
        api.enter(row())
        assert.are.same(row(), vim.json.decode(calls[1].argv[4]))
        calls[1].callback(nil, { result = { intent = { commandId = f.id(9), ref = row(), digest = string.rep("c", 64), state = "prepared" },
            enrollment = { inventoryId = f.id(8), hostId = string.rep("b", 64), hostname = "devbox-b", agyPath = "/opt/agy", loginShell = "/bin/bash" } } })
        assert.are.same(before, vim.fn.winlayout()); assert.are.equal(1, #launches)
        assert.are.equal("ssh", launches[1][1]); assert.is_truthy(table.concat(launches[1], " "):find(f.id(9), 1, true))
        assert.is_nil(table.concat(launches[1], " "):find("--remote%-expr")); assert.are.equal(0, #notices)
        vim.cmd("only")
    end)
    it("rejects substituted identity and stale intent before launching SSH", function()
        local callback, launches, notices = nil, 0, {}
        local api = remote.new({ client = { command = function(_, _, cb) callback = cb end }, uuid = function() return f.id(9) end,
            launch = function() launches = launches + 1 end, notify = function(value) notices[#notices + 1] = value end,
            control_path = function() return "/fixture/%C" end })
        api.enter(row()); callback(nil, { result = { intent = { commandId = f.id(9), ref = row(), digest = string.rep("c", 64), state = "prepared" },
            enrollment = { inventoryId = f.id(8), hostId = string.rep("a", 64), hostname = "replacement", agyPath = "/opt/agy", loginShell = "/bin/bash" } } })
        assert.are.equal(0, launches); assert.are.equal(1, #notices)
    end)
end)