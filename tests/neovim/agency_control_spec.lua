describe("Agency control transport", function()
    it("accepts V3 restore receipts and supplies a fresh editor environment", function()
        local control = require("sodium.agency.control")
        local arguments, options, finish, value
        local id = "00000000-0000-0000-0000-000000000001"
        local client = control.new({ system = function(argv, opts, callback)
            arguments, options, finish = argv, opts, callback
            return { kill = function() end }
        end, schedule = function(callback) callback() end })
        client.command({ "agent", "restore", id }, {}, function(err, reply)
            assert.is_nil(err)
            value = reply
        end)
        assert.are.equal("--json", arguments[#arguments])
        assert.are.equal(vim.v.servername, options.env.NVIM)
        finish({ code = 0, stdout = vim.json.encode({ protocol = "agency-agent/3", requestId = id, handlerGeneration = id, commandId = id, ok = true, result = { state = "command", durability = "verified", command = { version = 3, commandId = id, handlerGeneration = id, op = "restore", agentId = id, state = "completed", target = { agentId = id, handlerGeneration = id, providerGeneration = id }, result = { outcome = "restored" } } } }) })
        assert.are.equal("restored", value.result.command.result.outcome)
    end)

    it("rejects success envelopes whose command identity does not match the request", function()
        local control = require("sodium.agency.control")
        local finish, failure
        local id = "00000000-0000-0000-0000-000000000001"
        local client = control.new({ system = function(_, _, callback) finish = callback; return { kill = function() end } end, schedule = function(callback) callback() end })
        client.command({ "agent", "restore", id, "--command-id", id }, {}, function(err) failure = err end)
        finish({ code = 0, stdout = vim.json.encode({ protocol = "agency-agent/3", requestId = id, handlerGeneration = id, commandId = id, ok = true, result = { state = "command", durability = "verified", command = { version = 3, commandId = "00000000-0000-0000-0000-000000000002", handlerGeneration = id, op = "restore", agentId = id, state = "completed", result = { outcome = "restored" } } } }) })
        assert.are.equal("INVALID_PROTOCOL", failure.code)
    end)
end)