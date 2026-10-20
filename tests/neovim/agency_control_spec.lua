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

describe("Agency owner envelopes", function()
    local id = "00000000-0000-4000-8000-000000000001"
    local host = string.rep("a", 64)
    local function exchange(argv, value)
        local failure, result
        local client = require("sodium.agency.control").new({ system = function(_, _, cb)
            cb({ code = 0, stdout = vim.json.encode(value) }); return { kill = function() end }
        end, schedule = function(cb) cb() end })
        client.command(argv, {}, function(err, reply) failure, result = err, reply end)
        client.close(); return failure, result
    end
    it("accepts aggregate null identities and unavailable owners", function()
        local failure, result = exchange({ "roster", "list" }, { protocol = "agency-host/1", requestId = id,
            hostId = vim.NIL, handlerGeneration = vim.NIL, ok = true, result = { state = "roster", localHostId = host,
                hosts = { { hostId = host, hostname = "local", state = "unavailable", code = "UNAVAILABLE" } } } })
        assert.is_nil(failure); assert.are.equal("roster", result.result.state)
    end)
    it("rejects a substituted permission command and foreign owner", function()
        local ref = { hostId = host, target = { agentId = id, handlerGeneration = id, providerGeneration = id }, permissionId = id, revision = 1 }
        local value = { protocol = "agency-host/1", requestId = id, hostId = host, handlerGeneration = id, commandId = id,
            ok = true, result = { state = "permission", receipt = { commandId = "00000000-0000-4000-8000-000000000002", ref = ref, optionId = "allow", state = "applied" } } }
        local err = exchange({ "permission", "decide", "--input-json", vim.json.encode({ commandId = id, ref = ref, optionId = "allow" }) }, value)
        assert.are.equal("INVALID_PROTOCOL", err.code)
        value.result.receipt.commandId = id
        err = exchange({ "permission", "inspect", id, "--host", string.rep("b", 64) }, value)
        assert.are.equal("INVALID_PROTOCOL", err.code)
    end)
    it("preserves explicit local permission receipt envelopes", function()
        local failure = exchange({ "permission", "inspect", id, "--local" }, { protocol = "agency-agent/3", requestId = id,
            handlerGeneration = id, ok = true, result = { state = "permission", receipt = vim.NIL } })
        assert.is_nil(failure)
    end)
end)
describe("Agency runtime entry envelope", function()
    local id = "00000000-0000-4000-8000-000000000001"
    local host = string.rep("a", 64)
    local target = { agentId = id, handlerGeneration = id, providerGeneration = id }
    local function exchange(argv, value)
        local failure
        local client = require("sodium.agency.control").new({ system = function(_, _, cb)
            cb({ code = 0, stdout = vim.json.encode(value) }); return { kill = function() end }
        end, schedule = function(cb) cb() end })
        client.command(argv, {}, function(err) failure = err end); client.close(); return failure
    end
    it("rejects a valid host result for a different operation", function()
        local err = exchange({ "permission", "list", "--host", host }, { protocol = "agency-host/1", requestId = id, hostId = host,
            handlerGeneration = id, ok = true, result = { state = "page", revision = id, agents = {}, issues = {}, nextCursor = vim.NIL } })
        assert.are.equal("INVALID_PROTOCOL", err.code)
    end)
    it("rejects substituted commands and exact provider tuples", function()
        local argv = { "entry", "open", "--input-json", vim.json.encode({ commandId = id, hostId = host, target = target }) }
        local value = { protocol = "agency-host/1", requestId = id, hostId = host, handlerGeneration = id, commandId = id,
            ok = true, result = { state = "entry", enrollment = vim.NIL, receipt = { commandId = id, ref = { hostId = host, target = target },
                state = "opened", editor = { editorId = id, session = "entry", pane = "%1", tmuxSocketPath = "/fixture/socket" } } } }
        assert.is_nil(exchange(argv, value))
        value.result.receipt = vim.deepcopy(value.result.receipt)
        value.result.receipt.ref.target.providerGeneration = "00000000-0000-4000-8000-000000000002"
        assert.are.equal("INVALID_PROTOCOL", exchange(argv, value).code)
        value.result.receipt.ref.target = target
        value.result.receipt.commandId = "00000000-0000-4000-8000-000000000002"
        assert.are.equal("INVALID_PROTOCOL", exchange(argv, value).code)
    end)
end)

describe("Agency aggregate transport", function()
    it("accepts a legal permission aggregate above eight MiB in streamed and completed output", function()
        local id, host = "00000000-0000-4000-8000-000000000001", string.rep("a", 64)
        local pending = {}
        for index = 1, 11 do
            local permission_id = string.format("00000000-0000-4000-8000-%012d", index)
            pending[index] = { ref = { hostId = host, target = { agentId = id, handlerGeneration = id, providerGeneration = id }, permissionId = permission_id, revision = 1 },
                title = "Large", toolCallId = "tool-" .. index, originCwd = "/work", subject = vim.empty_dict(),
                options = { { optionId = "allow", name = string.rep("x", 400000), kind = "allow_once" } } }
            assert.is_true(#vim.json.encode(pending[index]) < 1048576)
        end
        local snapshot = { hostId = host, handlerGeneration = id, throughSeq = 11, pending = pending, receipts = {} }
        local value = { protocol = "agency-host/1", requestId = id, hostId = vim.NIL, handlerGeneration = vim.NIL, ok = true,
            result = { state = "permissions", hosts = { { hostId = host, hostname = "owner", state = "available", value = snapshot } }, pending = pending } }
        local raw = vim.json.encode(value)
        assert.is_true(#raw > 8388608)
        for _, streamed in ipairs({ false, true }) do
            local finish, options, failure, received, killed = nil, nil, nil, nil, 0
            local client = require("sodium.agency.control").new({ system = function(_, opts, cb)
                options, finish = opts, cb; return { kill = function() killed = killed + 1 end }
            end, schedule = function(cb) cb() end })
            client.command({ "permission", "list" }, {}, function(err, reply) failure, received = err, reply end)
            if streamed then for offset = 1, #raw, 65536 do options.stdout(nil, raw:sub(offset, offset + 65535)) end end
            finish({ code = 0, stdout = streamed and "" or raw })
            assert.is_nil(failure); assert.are.equal(11, #received.result.pending); assert.are.equal(0, killed)
            client.close()
        end
    end)
end)

describe("Agency retired protocol refusal", function()
    it("rejects Bureau envelopes for an ordinary command", function()
        local failure
        local client = require("sodium.agency.control").new({ system = function(_, _, cb)
            cb({ code = 0, stdout = vim.json.encode({ protocol = "agency-bureau-v1",
                requestId = "00000000-0000-4000-8000-000000000001", handlerGeneration = vim.NIL,
                ok = true, result = { state = "roster" } }) })
            return { kill = function() end }
        end, schedule = function(cb) cb() end })
        client.command({ "roster", "list" }, {}, function(err) failure = err end)
        assert.are.equal("INVALID_PROTOCOL", failure.code)
        client.close()
    end)
end)