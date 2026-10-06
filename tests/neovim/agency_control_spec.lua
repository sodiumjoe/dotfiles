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
        finish({ code = 0, stdout = vim.json.encode({ protocol = "agency-agent/3", requestId = id, handlerGeneration = id, commandId = id, ok = true, result = { state = "command", durability = "verified", command = { version = 3, commandId = id, handlerGeneration = id, op = "restore", agentId = id, state = "completed", target = { agentId = id, handlerGeneration = id, providerGeneration = id }, result = { outcome = "restored", target = { agentId = id, handlerGeneration = id, providerGeneration = id }, failure = vim.NIL } } } }) })
        assert.are.equal("restored", value.result.command.result.outcome)
    end)

    it("rejects malformed live V3 targets and non-live imported masquerades", function()
        local control = require("sodium.agency.control")
        local id = "00000000-0000-0000-0000-000000000001"
        for _, launch in ipairs({ { handlerGeneration = "invalid", providerGeneration = id }, vim.NIL }) do
            local finish, failure
            local client = control.new({ system = function(_, _, cb) finish = cb; return { kill = function() end } end,
                schedule = function(cb) cb() end })
            client.command({ "agent", "page" }, {}, function(err) failure = err end)
            finish({ code = 0, stdout = vim.json.encode({ protocol = "agency-agent/3", requestId = id, handlerGeneration = id, ok = true,
                result = { state = "page", revision = id, nextCursor = vim.NIL, issues = {}, agents = {
                    { record = { version = 3, definition = { agentId = id, cwd = "/work", backendId = "codex-acp" },
                        launch = launch, phase = "ready", settings = {} }, live = true, cleanup = "unverified" } } } }) })
            assert.are.equal("INVALID_PROTOCOL", failure.code)
        end
    end)

    it("accepts failed and interrupted V3 records in mixed inventory", function()
        local control = require("sodium.agency.control")
        local id = "00000000-0000-0000-0000-000000000001"
        for _, phase in ipairs({ "failed", "interrupted" }) do
            local finish, failure
            local client = control.new({ system = function(_, _, cb) finish = cb; return { kill = function() end } end,
                schedule = function(cb) cb() end })
            client.command({ "agent", "page", "--limit", "100" }, {}, function(err) failure = err end)
            local record = { version = 3, definition = { agentId = id, cwd = "/work", backendId = "codex-acp" },
                launch = vim.NIL, phase = phase, settings = {} }
            local result = { state = "page", revision = id, nextCursor = vim.NIL, issues = {},
                agents = { { record = record, live = false, cleanup = "not_launched" } } }
            finish({ code = 0, stdout = vim.json.encode({ protocol = "agency-agent/3", requestId = id,
                handlerGeneration = id, ok = true, result = result }) })
            assert.is_nil(failure)
        end
    end)

    it("rejects receipts from another requested Handler generation", function()
        local control = require("sodium.agency.control")
        local id = "00000000-0000-0000-0000-000000000001"
        local other = "00000000-0000-0000-0000-000000000002"
        local finish, failure
        local client = control.new({ system = function(_, _, cb) finish = cb; return { kill = function() end } end,
            schedule = function(cb) cb() end })
        client.command({ "agent", "restore", id, "--expected-handler-generation", id }, {}, function(err) failure = err end)
        finish({ code = 0, stdout = vim.json.encode({ protocol = "agency-agent/3", requestId = id, handlerGeneration = other,
            commandId = id, ok = true, result = { state = "command", durability = "verified", command = { version = 3,
                commandId = id, handlerGeneration = other, agentId = id, op = "restore", state = "completed",
                result = { outcome = "restored", target = { agentId = id, handlerGeneration = other, providerGeneration = id }, failure = vim.NIL } } } }) })
        assert.are.equal("INVALID_PROTOCOL", failure.code)
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