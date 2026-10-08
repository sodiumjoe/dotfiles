package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
local fixture = require("fixtures.agency_control")
local function offer(host, agent)
    return { ref = { hostId = string.rep(host, 64), target = { agentId = fixture.id(agent), handlerGeneration = fixture.id(2), providerGeneration = fixture.id(3) }, permissionId = fixture.id(agent + 10), revision = 1 },
        title = "Edit", toolCallId = "same-tool", originCwd = "/remote/work", subject = { kind = "future", paths = { "/remote/work/file" } },
        options = { { optionId = "allow", name = "Allow once", kind = "allow_once" }, { optionId = "deny", name = "Reject once", kind = "reject_once" } } }
end
describe("Agency routed human approvals", function()
    it("keeps equal tool-call IDs on two origins separate from native permissions", function()
        local api = require("sodium.agency.permissions").new({ command = function() end })
        local a, b = offer("a", 1), offer("b", 4)
        api.update({ pending = { a, b } })
        assert.are.equal(2, #api.pending())
        assert.are.same(a.subject, api.pending()[1].subject)
        assert.is_truthy(api.preview(a):find(a.ref.hostId, 1, true))
    end)
    it("decides through an origin-ref CLI command using the advertised option ID", function()
        local calls, callback = {}, nil
        local api = require("sodium.agency.permissions").new({ uuid = function() return fixture.id(99) end,
            select = function(options, _, cb) assert.are.equal("deny", options[2].optionId); callback = cb end,
            command = function(argv, _, cb) calls[#calls + 1] = argv; cb(nil, { result = { state = "applied" } }) end })
        local a = offer("a", 1); api.update({ pending = { a } }); api.choose(a.ref)
        callback(a.options[2])
        assert.are.same({ "permission", "decide" }, { calls[1][1], calls[1][2] })
        assert.are.equal(fixture.id(99), calls[1][4])
        local input = vim.json.decode(calls[1][6]); assert.are.same(a.ref, input.ref); assert.are.equal("deny", input.optionId)
    end)
    it("withdrawal and controller close invalidate outstanding option callbacks", function()
        local callback, calls = nil, 0
        local api = require("sodium.agency.permissions").new({ select = function(_, _, cb) callback = cb end,
            command = function() calls = calls + 1 end })
        local a = offer("a", 1); api.update({ pending = { a } }); api.choose(a.ref)
        api.update({ pending = {} }); callback(a.options[1]); assert.are.equal(0, calls)
        api.update({ pending = { a } }); api.choose(a.ref); api.close(); callback(a.options[1]); assert.are.equal(0, calls)
    end)
    it("stream loss invalidates an open decision even if the same offer later returns", function()
        local update, lost, callback, calls, closed = nil, nil, nil, 0, false
        local api = require("sodium.agency.permissions").new({ watch = function()
            return { start = function(_, cb, failure) update, lost = cb, failure end, close = function() closed = true end }
        end, select = function(_, _, cb) callback = cb end, command = function() calls = calls + 1 end })
        local a = offer("a", 1); api.subscribe(); update({ pending = { a } }); api.choose(a.ref)
        lost(); update({ pending = { a } }); callback(a.options[1]); assert.are.equal(0, calls)
        api.close(); assert.is_true(closed)
        update({ pending = { a } }); assert.are.equal(0, #api.pending())
    end)
    it("renders full opaque subjects in the routed approval preview", function()
        local original, options = _G.Snacks, nil
        local a = offer("a", 1)
        _G.Snacks = { picker = function(value) options = value end }
        local api = require("sodium.agency.permissions").new({ command = function(_, _, cb) cb(nil, { result = { pending = { a } } }) end })
        api.open()
        local lines = {}
        assert.are.equal("function", type(options.preview))
        options.preview({ item = options.items[1], preview = { reset = function() end, set_lines = function(_, value) lines = value end } })
        local rendered = table.concat(lines, "\n")
        assert.is_truthy(rendered:find("/remote/work/file", 1, true))
        assert.is_truthy(rendered:find(a.ref.target.providerGeneration, 1, true))
        api.close(); _G.Snacks = original
    end)
end)