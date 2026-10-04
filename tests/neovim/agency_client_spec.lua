package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
local fixture = require("fixtures.agency")

describe("Agency subprocess client", function()
    it("rejects malformed catalog refresh receipts and mismatched retained identities", function()
        for _, mutate in ipairs({
            function(result) result.command = nil end,
            function(result) result.command.commandId = fixture.id(602) end,
            function(result) result.command.handlerGeneration = fixture.id(602) end,
            function(result) result.snapshot.snapshotId = fixture.id(602) end,
            function(result) result.snapshot.version = 9 end,
            function(result) result.snapshot.providers = { { providerId = "unknown" } } end,
            function(result) result.command.state = "pending" end,
        }) do
            local f = fixture.client()
            local error
            f.client.command({ "model", "refresh", "--command-id", fixture.id(600), "--handler-generation", fixture.target_a.handlerGeneration }, {}, function(err)
                error = err
            end)
            local result = fixture.refresh()
            mutate(result)
            f.jobs[1].exit({ code = 0, stdout = vim.json.encode({ protocol = "agency-catalog/1", requestId = fixture.id(605),
                handlerGeneration = fixture.target_a.handlerGeneration, ok = true, result = result }) })
            f.drain()
            assert.are.equal("INVALID_PROTOCOL", error and error.code)
            f.close()
        end
    end)
    it("accepts a completed refresh bound to its exact snapshot", function()
        local f = fixture.client()
        local error, result
        f.client.command({ "model", "refresh", "--command-id", fixture.id(600), "--handler-generation", fixture.target_a.handlerGeneration }, {}, function(err, value)
            error, result = err, value
        end)
        f.jobs[1].exit({ code = 0, stdout = vim.json.encode({ protocol = "agency-catalog/1", requestId = fixture.id(605),
            handlerGeneration = fixture.target_a.handlerGeneration, ok = true, result = fixture.refresh() }) })
        f.drain()
        assert.is_nil(error)
        assert.are.equal(fixture.id(601), result.result.snapshot.snapshotId)
        f.close()
    end)
    it("settles an acknowledgment lost between decoding and scheduled delivery as unavailable", function()
        local f = fixture.client()
        local stream = f.client.attach(f.target_a, f.handlers)
        f.deliver(1, f.snapshot_a)
        local error
        stream.request({ op = "inspect-submission", submissionId = fixture.id(601) }, function(value)
            error = value
        end)
        local request = vim.json.decode(f.jobs[1].writes[1])
        f.jobs[1].options.stdout(
            nil,
            vim.json.encode({
                protocol = "agency-attachment/1",
                target = f.target_a,
                type = "response",
                requestId = request.requestId,
                ok = true,
                receipt = vim.NIL,
            }) .. "\n"
        )
        stream.close()
        f.drain()
        assert.are.equal("UNAVAILABLE", error.code)
        f.close()
    end)

    it("reports requests made after detach without writing to the proxy", function()
        local f = fixture.client()
        local stream = f.client.attach(f.target_a, f.handlers)
        f.deliver(1, f.snapshot_a)
        stream.close()
        local error
        stream.request({ op = "cancel", submissionId = fixture.id(601) }, function(value)
            error = value
        end)
        f.drain()
        assert.are.equal("UNAVAILABLE", error.code)
        assert.are.equal(0, #f.jobs[1].writes)
        f.close()
    end)

    it("rejects incomplete status envelopes before retaining a launch generation", function()
        local f = fixture.client()
        local error
        f.client.command({ "status" }, {}, function(value)
            error = value
        end)
        f.jobs[1].exit({
            code = 0,
            stdout = vim.json.encode({
                protocol = "agency-control/2",
                requestId = fixture.id(600),
                handlerGeneration = f.target_a.handlerGeneration,
                ok = true,
                result = { phase = "ready", handlerGeneration = f.target_a.handlerGeneration },
            }),
        })
        f.drain()
        assert.are.equal("INVALID_PROTOCOL", error.code)
        f.close()
    end)
    it("limits frames individually when one read exceeds two MiB", function()
        local f = fixture.client()
        f.client.attach(f.target_a, f.handlers)
        f.deliver(1, f.snapshot_a)
        local lines = {}
        for seq = 2, 31 do
            lines[#lines + 1] = vim.json.encode({
                protocol = "agency-attachment/1",
                target = f.target_a,
                type = "event",
                event = fixture.event(seq, string.rep("x", 100000)),
                firstSeq = 1,
                historyTruncated = false,
            }) .. "\n"
        end
        f.jobs[1].options.stdout(nil, table.concat(lines))
        f.drain()
        assert.are.equal(33, #f.observed)
        assert.are.equal(0, #f.faults)
        f.close()
    end)

    it("rejects an oversized incomplete line before waiting for EOF", function()
        local f = fixture.client()
        f.client.attach(f.target_a, f.handlers)
        f.jobs[1].options.stdout(nil, string.rep("x", 2097152))
        f.drain()
        assert.are.equal("INVALID_PROTOCOL", f.faults[1].code)
        assert.is_true(f.jobs[1].killed)
        f.close()
    end)
    it("validates complete paged records before offering a ready attachment", function()
        for _, mutate in ipairs({
            function(view)
                view.record.launch.launchAttemptId = nil
            end,
            function(view)
                view.record.launch.authority = "root"
            end,
            function(view)
                view.record.session = vim.NIL
            end,
            function(view)
                view.launch.owner.providerGeneration = fixture.id(999)
            end,
            function(view)
                view.record.launch.catalogEvidence.verifiedHandlerGeneration = fixture.id(999)
            end,
        }) do
            local f = fixture.client()
            local error
            f.client.command({ "agent", "page", "--limit", "100" }, {}, function(value)
                error = value
            end)
            local view = fixture.agent(f.target_a)
            mutate(view)
            f.jobs[1].exit({
                code = 0,
                stdout = vim.json.encode({
                    protocol = "agency-agent/2",
                    requestId = fixture.id(600),
                    handlerGeneration = f.target_a.handlerGeneration,
                    ok = true,
                    result = fixture.page({ view }),
                }),
            })
            f.drain()
            assert.are.equal("INVALID_PROTOCOL", error.code)
            f.close()
        end
    end)

    it("accepts a complete ready record while preserving diagnostic pages", function()
        local f = fixture.client()
        local error, result
        f.client.command({ "agent", "page", "--limit", "100" }, {}, function(e, value)
            error, result = e, value
        end)
        local page = fixture.page({ fixture.agent(f.target_a) })
        page.issues = { { kind = "agent", id = vim.NIL, path = "/state/broken", message = "invalid state" } }
        f.jobs[1].exit({
            code = 69,
            stdout = vim.json.encode({
                protocol = "agency-agent/2",
                requestId = fixture.id(600),
                handlerGeneration = f.target_a.handlerGeneration,
                ok = true,
                result = page,
            }),
        })
        f.drain()
        assert.is_nil(error)
        assert.are.equal(1, #result.result.agents)
        assert.are.equal(1, #result.result.issues)
        f.close()
    end)
    it("rejects invalid UTF-8 instead of normalizing payload bytes", function()
        local f = fixture.client()
        f.client.attach(f.target_a, f.handlers)
        f.deliver(1, { f.snapshot_a[1] })
        local frame = vim.json.encode(f.snapshot_a[2])
        frame = frame:gsub("answer", "bad" .. string.char(255), 1)
        f.jobs[1].options.stdout(nil, frame .. "\n")
        f.drain()
        assert.are.equal("INVALID_PROTOCOL", f.faults[1].code)
        assert.are.equal(1, #f.observed)
        f.close()
    end)

    it("rejects a completed mutation receipt with the wrong operation input", function()
        local f = fixture.client()
        local error
        f.client.command({
            "agent",
            "restore",
            fixture.target_a.agentId,
            "--command-id",
            fixture.id(301),
            "--expected-handler-generation",
            fixture.target_a.handlerGeneration,
        }, { cwd = "/work/a" }, function(value)
            error = value
        end)
        local result = fixture.command(fixture.target_a, "restored")
        result.command.input.agentId = fixture.id(999)
        f.jobs[1].exit({
            code = 0,
            stdout = vim.json.encode({
                protocol = "agency-agent/2",
                requestId = fixture.id(600),
                handlerGeneration = fixture.target_a.handlerGeneration,
                commandId = fixture.id(301),
                ok = true,
                result = result,
            }),
        })
        f.drain()
        assert.are.equal("INVALID_PROTOCOL", error.code)
        f.close()
    end)

    it("disconnects a slow scheduled reader before retaining unlimited events", function()
        local f = fixture.client()
        f.client.attach(f.target_a, f.handlers)
        f.deliver(1, f.snapshot_a)
        for seq = 2, 40 do
            local value = {
                protocol = "agency-attachment/1",
                target = f.target_a,
                type = "event",
                event = fixture.event(seq, string.rep("x", 200000)),
                firstSeq = 1,
                historyTruncated = false,
            }
            f.jobs[1].options.stdout(nil, vim.json.encode(value) .. "\n")
        end
        f.drain()
        assert.are.equal("INCOMPLETE", f.faults[1].code)
        assert.is_true(#f.observed < 40)
        f.close()
    end)

    it("rejects unknown fields, wrong targets, and premature events", function()
        for _, mutate in ipairs({
            function(frame)
                frame.unknown = true
            end,
            function(frame)
                frame.target = fixture.target_b
            end,
            function(frame)
                frame.metadata.session.protocolVersion = 2
            end,
            function(frame)
                frame.limits.inputBytes = 1048576
            end,
        }) do
            local f = fixture.client()
            f.client.attach(f.target_a, f.handlers)
            local frame = vim.deepcopy(f.snapshot_a[1])
            mutate(frame)
            f.deliver(1, { frame })
            assert.are.equal("INVALID_PROTOCOL", f.faults[1].code)
            f.close()
        end
        local f = fixture.client()
        f.client.attach(f.target_a, f.handlers)
        f.deliver(1, {
            {
                protocol = "agency-attachment/1",
                target = f.target_a,
                type = "event",
                event = fixture.event(1),
                firstSeq = 1,
                historyTruncated = false,
            },
        })
        assert.are.equal("INVALID_PROTOCOL", f.faults[1].code)
        f.close()
    end)

    it("preserves pending command output with a nonzero operation exit", function()
        local f = fixture.client()
        local result, error
        f.client.command({ "agent", "restore", fixture.target_a.agentId }, { cwd = "/work/a" }, function(e, value)
            error, result = e, value
        end)
        local command = fixture.command(fixture.target_a, "pending", nil, "restore")
        f.jobs[1].exit({
            code = 75,
            stdout = vim.json.encode({
                protocol = "agency-agent/2",
                requestId = fixture.id(600),
                handlerGeneration = fixture.target_a.handlerGeneration,
                commandId = fixture.id(301),
                ok = true,
                result = command,
            }),
        })
        f.drain()
        assert.is_nil(error)
        assert.are.equal("pending", result.result.command.state)
        f.close()
    end)

    it("closes only timed out commands and ignores late completion", function()
        local f = fixture.client()
        local replies = {}
        f.client.command({ "agent", "page", "--limit", "100" }, { cwd = "/work/a" }, function(error)
            replies[#replies + 1] = error
        end)
        f.timers[1].callback()
        f.drain()
        assert.are.equal("UNAVAILABLE", replies[1].code)
        assert.is_true(f.jobs[1].killed)
        f.jobs[1].exit({
            code = 0,
            stdout = vim.json.encode({
                protocol = "agency-agent/2",
                requestId = fixture.id(600),
                handlerGeneration = f.target_a.handlerGeneration,
                ok = true,
                result = fixture.page(),
            }),
        })
        f.drain()
        assert.are.equal(1, #replies)
        f.close()
    end)

    it("matches response and submission identities before acknowledging", function()
        local f = fixture.client()
        local reply
        local stream = f.client.attach(f.target_a, f.handlers)
        f.deliver(1, f.snapshot_a)
        stream.request({ op = "submit", submissionId = fixture.id(601), text = "one" }, function(error, value)
            reply = { error, value }
        end)
        local request = vim.json.decode(f.jobs[1].writes[1])
        assert.are.same(f.target_a, request.target)
        f.deliver(1, {
            {
                protocol = "agency-attachment/1",
                target = f.target_a,
                type = "response",
                requestId = request.requestId,
                ok = true,
                receipt = {
                    submissionId = fixture.id(602),
                    digest = string.rep("a", 64),
                    state = "accepted",
                    stopReason = vim.NIL,
                    failure = vim.NIL,
                    acceptedSeq = 2,
                    completedSeq = vim.NIL,
                },
            },
        })
        assert.are.equal("INVALID_PROTOCOL", f.faults[1].code)
        assert.are.equal("UNAVAILABLE", reply[1].code)
        f.close()
    end)

    it("invalidates already scheduled callbacks on explicit detach", function()
        local f = fixture.client()
        local stream = f.client.attach(f.target_a, f.handlers)
        for _, frame in ipairs(f.snapshot_a) do
            f.jobs[1].options.stdout(nil, vim.json.encode(frame) .. "\n")
        end
        stream.close()
        f.drain()
        assert.are.equal(0, #f.observed)
        assert.are.equal(0, #f.faults)
        f.close()
    end)

    it("ignores callbacks from a replaced attachment", function()
        local f = fixture.client()
        local first = f.client.attach(f.target_a, f.handlers)
        first.close()
        f.client.attach(f.target_b, f.handlers)
        f.deliver(1, f.snapshot_a)
        assert.are.equal(0, #f.observed)
        assert.is_true(f.jobs[1].killed)
        f.close()
    end)

    it("passes argument boundaries and captured cwd without storing an environment", function()
        local f = fixture.client()
        local replies = {}
        f.client.command(
            { "agent", "page", "--limit", "100", "--cwd", "/work/a b" },
            { cwd = "/work/a b", timeout_ms = 1000 },
            function(error, result)
                replies[#replies + 1] = { error, result }
            end
        )
        assert.are.same({ "agy", "agent", "page", "--limit", "100", "--cwd", "/work/a b", "--json" }, f.jobs[1].argv)
        assert.are.equal("/work/a b", f.jobs[1].options.cwd)
        assert.is_nil(f.jobs[1].options.env)
        f.jobs[1].exit({
            code = 0,
            stdout = vim.json.encode({
                protocol = "agency-agent/2",
                requestId = fixture.id(600),
                handlerGeneration = f.target_a.handlerGeneration,
                ok = true,
                result = fixture.page(),
            }),
            stderr = "diagnostic",
        })
        assert.are.equal(0, #replies)
        f.drain()
        assert.is_nil(replies[1][1])
        assert.are.equal("page", replies[1][2].result.state)
        f.close()
    end)

    it("decodes fragmented UTF-8 and multiple frames in one read", function()
        local f = fixture.client()
        f.client.attach(f.target_a, f.handlers)
        local frames = fixture.snapshot(f.target_a, { fixture.event(1, "α😀") })
        local bytes = {}
        for _, frame in ipairs(frames) do
            bytes[#bytes + 1] = vim.json.encode(frame) .. "\n"
        end
        local wire = table.concat(bytes)
        for i = 1, #wire do
            f.jobs[1].options.stdout(nil, wire:sub(i, i))
        end
        f.drain()
        assert.are.equal(3, #f.observed)
        assert.are.equal("α😀", f.observed[2].events[1].update.content.text)
        f.close()
    end)

    it("rejects a partial frame at exit and never sends stop or cancel", function()
        local f = fixture.client()
        f.client.attach(f.target_a, f.handlers)
        f.jobs[1].options.stdout(nil, '{"protocol":')
        f.jobs[1].exit({ code = 0, stdout = "", stderr = "private diagnostic" })
        f.drain()
        assert.are.equal("INVALID_PROTOCOL", f.faults[1].code)
        assert.are.equal(0, #f.jobs[1].writes)
        assert.are.equal("attach", f.jobs[1].argv[3])
        f.close()
    end)

    it("bounds handshake and acknowledgments without an active idle deadline", function()
        local f = fixture.client()
        local stream = f.client.attach(f.target_a, f.handlers)
        assert.are.equal(5000, f.timers[1].ms)
        f.deliver(1, f.snapshot_a)
        assert.is_false(f.timers[1].active)
        local result
        stream.request({ op = "inspect-submission", submissionId = fixture.id(601) }, function(error)
            result = error
        end)
        f.timers[2].callback()
        f.drain()
        assert.are.equal("UNAVAILABLE", result.code)
        assert.are.equal(1, #f.jobs[1].writes)
        f.close()
    end)
end)