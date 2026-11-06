package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
describe("Agency command stdin", function()
    local control = require("sodium.agency.control")
    local f = require("fixtures.agency_control")
    local host = string.rep("a", 64)
    local function envelope(result)
        return { protocol = "agency-host/1", requestId = f.id(10), commandId = f.id(11),
            hostId = host, handlerGeneration = f.id(2), ok = true, result = result }
    end
    local function issue(argv, reply)
        local launched, options, complete, err, result
        local client = control.new({ executable = "fixture-agy", schedule = function(fn) fn() end,
            system = function(args, opts, callback)
                launched, options, complete = args, opts, callback
                return { kill = function() end }
            end })
        client.command(argv, {}, function(error, value) err, result = error, value end)
        options.stdout(nil, vim.json.encode(reply))
        complete({ code = 0, stdout = "" })
        client.close()
        return { argv = launched, options = options, err = err, result = result }
    end
    local function permission()
        local ref = { hostId = host, target = vim.deepcopy(f.target_a), permissionId = f.id(12), revision = 1 }
        local input = { commandId = f.id(11), ref = ref, optionId = string.rep("x", 1500) }
        return input, envelope({ state = "permission", receipt = { commandId = f.id(11), ref = ref,
            optionId = input.optionId, state = "applied", digest = string.rep("b", 64) } })
    end
    it("sends the exact permission payload on stdin and retains caller argv", function()
        local input, reply = permission()
        local payload = vim.json.encode(input)
        local argv = { "permission", "decide", "--host", host, "--input-json", payload }
        local result = issue(argv, reply)
        assert.are.same({ "fixture-agy", "permission", "decide", "--host", host, "--input-json", "-", "--json" }, result.argv)
        assert.are.equal(payload, result.options.stdin)
        assert.are.equal(payload, argv[6])
        assert.is_nil(result.err)
        assert.are.equal("applied", result.result.result.receipt.state)
    end)
    for _, changed in ipairs({ "option", "ref", "command" }) do
        it("rejects a permission receipt with mismatched " .. changed, function()
            local input, reply = permission()
            reply = vim.deepcopy(reply)
            if changed == "option" then reply.result.receipt.optionId = "different" end
            if changed == "ref" then reply.result.receipt.ref.target.providerGeneration = f.id(50) end
            if changed == "command" then reply.result.receipt.commandId = f.id(50) end
            local result = issue({ "permission", "decide", "--input-json", vim.json.encode(input) }, reply)
            assert.are.equal("INVALID_PROTOCOL", result.err.code)
        end)
    end
    local function entry()
        local input = { commandId = f.id(11), hostId = host, target = vim.deepcopy(f.target_a) }
        local reply = envelope({ state = "entry", receipt = { commandId = f.id(11), ref = { hostId = host, target = vim.deepcopy(f.target_a) },
            state = "opened", editor = { editorId = f.id(20), session = "fixture", pane = "%1", tmuxSocketPath = "/tmp/fixture" } }, enrollment = vim.NIL })
        return input, reply
    end
    it("sends entry JSON on stdin and accepts its bound receipt", function()
        local input, reply = entry()
        local payload = string.rep(" ", 1500) .. vim.json.encode(input)
        local argv = { "entry", "open", "--input-json", payload }
        local result = issue(argv, reply)
        assert.are.equal("-", result.argv[5]); assert.are.equal(payload, result.options.stdin)
        assert.are.equal(payload, argv[4]); assert.is_nil(result.err)
    end)
    for _, changed in ipairs({ "target", "command" }) do
        it("rejects an entry receipt with mismatched " .. changed, function()
            local input, reply = entry()
            if changed == "target" then reply.result.receipt.ref.target.providerGeneration = f.id(50) end
            if changed == "command" then reply.commandId = f.id(50); reply.result.receipt.commandId = f.id(50) end
            local result = issue({ "entry", "open", "--input-json", vim.json.encode(input) }, reply)
            assert.are.equal("INVALID_PROTOCOL", result.err.code)
        end)
    end
    it("leaves ordinary reads without a stdin payload", function()
        local reply = { protocol = "agency-host/1", requestId = f.id(10), hostId = vim.NIL,
            handlerGeneration = vim.NIL, ok = true, result = { state = "hosts", hosts = {} } }
        local result = issue({ "host", "list" }, reply)
        assert.are.same({ "fixture-agy", "host", "list", "--json" }, result.argv)
        assert.is_nil(result.options.stdin); assert.is_nil(result.err)
    end)
    it("actual Neovim process launch delivers long stdin to the CLI parser", function()
        local client = control.new({ executable = vim.env.DOTFILES_TEST_ROOT .. "/home/bin/agy" })
        local done, error = false, nil
        client.command({ "git", "prepare", "--input-json", vim.json.encode({ fixture = string.rep("λ", 32768) }) }, {}, function(err)
            error, done = err, true
        end)
        assert.is_true(vim.wait(6000, function() return done end))
        client.close()
        assert.are.equal("USAGE", error.code)
    end)
end)