package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
local fixture = require("fixtures.agency_control")
local function setup()
    local output, done, kills, updates, faults = nil, nil, 0, {}, {}
    local api = require("sodium.agency.watch").new({ schedule = function(cb) cb() end,
        defer = function() end, system = function(_, options, callback)
            output, done = options.stdout, callback
            return { kill = function() kills = kills + 1 end }
        end })
    api.start({ "permission", "watch" }, function(value) updates[#updates + 1] = value end,
        function(code) faults[#faults + 1] = code end)
    return { api = api, output = function(chunk) output(nil, chunk) end, done = function() done({ code = 1 }) end,
        updates = updates, faults = faults, kills = function() return kills end }
end
local function frame(seq, kind, result)
    return vim.json.encode({ protocol = "agency-bureau-watch-v1", generation = fixture.id(1), seq = seq,
        kind = kind or "snapshot", result = result or { pending = {} }, error = { code = "BUREAU_UNAVAILABLE" } }) .. "\n"
end
describe("Agency snapshot streams", function()
    it("decodes split NDJSON chunks and replaces snapshots in order", function()
        local f, bytes = setup(), frame(1) .. frame(2, "snapshot", { pending = { "next" } })
        f.output(bytes:sub(1, 15)); assert.are.equal(0, #f.updates)
        f.output(bytes:sub(16)); assert.are.equal(2, #f.updates)
        assert.are.same({ "next" }, f.updates[2].pending)
        f.api.close(); assert.are.equal(1, f.kills())
    end)
    it("sequence gaps invalidate freshness and require a replacement stream", function()
        local f = setup(); f.output(frame(1)); f.output(frame(3))
        assert.are.equal(1, #f.updates); assert.are.same({ "INVALID_PROTOCOL" }, f.faults)
        assert.are.equal(1, f.kills())
        f.output(frame(4)); assert.are.equal(1, #f.updates)
    end)
    it("unavailability and closure invalidate observations and fence late callbacks", function()
        local f = setup(); f.output(frame(1)); f.output(frame(2, "unavailable"))
        assert.are.same({ "BUREAU_UNAVAILABLE" }, f.faults)
        f.output(frame(3)); assert.are.equal(2, #f.updates)
        f.api.close(); f.output(frame(4)); f.done()
        assert.are.equal(2, #f.updates); assert.are.equal(1, #f.faults)
    end)
end)