local M = {}

function M.id(n)
    return string.format("00000000-0000-4000-8000-%012d", n)
end

M.target_a = { agentId = M.id(1), handlerGeneration = M.id(2), providerGeneration = M.id(3) }
M.target_b = { agentId = M.id(11), handlerGeneration = M.id(12), providerGeneration = M.id(13) }
M.selection = {
    providerId = "codex-acp",
    modelId = "model-a",
    reasoning = { kind = "value", value = "high" },
    mode = "read-only",
    permissionProfile = "deny-all",
}
M.limits = {
    inputBytes = 262144,
    outputBytes = 786432,
    encodedTextBytes = 917504,
    allowEmptyAnswer = true,
    historyBytes = 16777216,
    historyEvents = 8192,
    metadataBytes = 65536,
}

function M.event(seq, text)
    local event = {
        kind = "update",
        seq = seq,
        replay = false,
        update = { sessionUpdate = "agent_message_chunk", content = { type = "text", text = text or "answer" } },
    }
    event.encodedBytes = #vim.json.encode(event) + 64
    return event
end

function M.snapshot(target, events, first)
    target = target or M.target_a
    events = events or { M.event(1) }
    first = first or 1
    local last = #events > 0 and events[#events].seq or first - 1
    local metadata = {
        phase = "ready",
        session = {
            sessionId = "fixture-session",
            sessionGeneration = M.id(90),
            protocolVersion = 1,
            modelId = "model-a",
            reasoning = M.selection.reasoning,
            mode = "read-only",
            permissionProfile = "deny-all",
            permissionEvidence = "agency-deny-all-v1",
        },
        selection = vim.deepcopy(M.selection),
        cwd = "/work/a",
        failure = vim.NIL,
        title = vim.NIL,
        plan = {},
        planTruncated = false,
        usage = vim.NIL,
    }
    local frames = {
        {
            protocol = "agency-attachment/1",
            target = vim.deepcopy(target),
            type = "snapshot_begin",
            snapshotId = M.id(100),
            sessionId = "fixture-session",
            cwd = "/work/a",
            selection = vim.deepcopy(M.selection),
            metadata = metadata,
            firstSeq = first,
            lastSeq = last,
            historyTruncated = first > 1,
            currentTurn = vim.NIL,
            limits = vim.deepcopy(M.limits),
        },
    }
    if #events > 0 then
        frames[#frames + 1] = {
            protocol = "agency-attachment/1",
            target = vim.deepcopy(target),
            type = "snapshot_events",
            snapshotId = M.id(100),
            chunkIndex = 0,
            events = vim.deepcopy(events),
        }
    end
    frames[#frames + 1] = {
        protocol = "agency-attachment/1",
        target = vim.deepcopy(target),
        type = "snapshot_end",
        snapshotId = M.id(100),
        firstSeq = first,
        lastSeq = last,
        historyTruncated = first > 1,
        chunkCount = #events > 0 and 1 or 0,
    }
    return frames
end

function M.client()
    local jobs, scheduled, timers, observed, faults = {}, {}, {}, {}, {}
    local uuid = 200
    local client = require("sodium.agency.client").new({
        system = function(argv, options, callback)
            local job = { argv = argv, options = options, exit = callback, writes = {}, killed = false }
            jobs[#jobs + 1] = job
            return {
                write = function(_, bytes)
                    job.writes[#job.writes + 1] = bytes
                end,
                kill = function()
                    job.killed = true
                end,
            }
        end,
        schedule = function(callback)
            scheduled[#scheduled + 1] = callback
        end,
        defer = function(callback, ms)
            local timer = { callback = callback, ms = ms, active = true }
            timers[#timers + 1] = timer
            return function()
                timer.active = false
            end
        end,
        uuid = function()
            uuid = uuid + 1
            return M.id(uuid)
        end,
    })
    local function drain()
        while #scheduled > 0 do
            table.remove(scheduled, 1)()
        end
    end
    return {
        client = client,
        jobs = jobs,
        observed = observed,
        faults = faults,
        timers = timers,
        target_a = vim.deepcopy(M.target_a),
        target_b = vim.deepcopy(M.target_b),
        snapshot_a = M.snapshot(M.target_a),
        snapshot_b = M.snapshot(M.target_b),
        handlers = {
            on_frame = function(frame)
                observed[#observed + 1] = frame
            end,
            on_fault = function(error)
                faults[#faults + 1] = error
            end,
        },
        deliver = function(index, frames)
            for _, frame in ipairs(frames) do
                jobs[index].options.stdout(nil, vim.json.encode(frame) .. "\n")
            end
            drain()
        end,
        drain = drain,
        close = function()
            client.close()
            drain()
        end,
    }
end

function M.operations()
    local calls, streams, selections, confirmations, reports = {}, {}, {}, {}, {}
    local n = 300
    local client = {
        command = function(argv, options, callback)
            calls[#calls + 1] = { argv = vim.deepcopy(argv), options = vim.deepcopy(options), callback = callback }
        end,
        attach = function(target, handlers)
            local stream = { target = vim.deepcopy(target), handlers = handlers, closed = false, requests = {} }
            streams[#streams + 1] = stream
            return {
                close = function()
                    stream.closed = true
                end,
                request = function(body, callback)
                    stream.requests[#stream.requests + 1] = { body = body, callback = callback }
                end,
            }
        end,
    }
    local operations = require("sodium.agency.operations").new({
        client = client,
        uuid = function()
            n = n + 1
            return M.id(n)
        end,
        select_choice = function(choices, callback)
            selections[#selections + 1] = { choices = choices, callback = callback }
        end,
        select_agent = function(agents, callback)
            selections[#selections + 1] = { agents = agents, callback = callback }
        end,
        confirm_stop = function(target, callback)
            confirmations[#confirmations + 1] = { target = target, callback = callback }
        end,
        report = function(value)
            reports[#reports + 1] = value
        end,
    })
    return {
        operations = operations,
        calls = calls,
        streams = streams,
        selections = selections,
        confirmations = confirmations,
        reports = reports,
        respond = function(index, result, error, generation)
            calls[index].callback(
                error,
                {
                    protocol = "agency-agent/2",
                    requestId = M.id(400 + index),
                    handlerGeneration = generation or M.target_a.handlerGeneration,
                    ok = error == nil,
                    result = result,
                }
            )
        end,
        snapshot = function(index)
            for _, frame in ipairs(M.snapshot(streams[index].target)) do
                streams[index].handlers.on_frame(frame, #vim.json.encode(frame) + 1)
            end
        end,
    }
end

function M.page(agents, cursor, revision)
    return {
        state = "page",
        revision = revision or M.id(500),
        agents = agents or {},
        issues = {},
        nextCursor = cursor or vim.NIL,
    }
end

function M.agent(target, phase)
    local launch = {
        handlerGeneration = target.handlerGeneration,
        providerGeneration = target.providerGeneration,
        launchAttemptId = M.id(80),
        commandId = M.id(301),
        catalogSnapshotId = M.id(81),
        catalogEvidence = {
            providerId = "codex-acp",
            fingerprint = string.rep("b", 64),
            verifiedAt = 1000,
            verifiedHandlerGeneration = target.handlerGeneration,
            providerVersion = vim.NIL,
            providerVersionSource = "unknown",
            adapterVersion = "1.0.0",
            sdkVersion = vim.NIL,
            error = vim.NIL,
            models = {
                {
                    providerId = "codex-acp",
                    modelId = "model-a",
                    resolvedModelId = vim.NIL,
                    displayName = "Model A",
                    reasoning = { state = "values", values = { "high", "low" } },
                    modes = { state = "unknown" },
                    availability = "advertised",
                },
            },
        },
        configuration = {
            fingerprint = string.rep("b", 64),
            scope = "declared-config-v1",
            providerId = "codex-acp",
            adapterVersion = "1.0.0",
            sdkVersion = vim.NIL,
        },
        contractId = "fixture-contract",
        contractFingerprint = string.rep("c", 64),
        containment = "direct-process-group-v1",
        authority = "normal-user",
        limits = {
            startupMs = 30000,
            rpcMs = 5000,
            frameBytes = 1048576,
            startupBytes = 8388608,
            writeQueueBytes = 1048576,
            stderrBytes = 8192,
        },
    }
    local process = {
        version = 2,
        owner = { kind = "agent", agentId = target.agentId, providerGeneration = target.providerGeneration },
        handlerGeneration = target.handlerGeneration,
        launchAttemptId = launch.launchAttemptId,
        launchBootId = "fixture-boot",
        launchAttempted = true,
        phase = "active",
        provider = vim.NIL,
        reason = vim.NIL,
    }
    return {
        record = {
            version = 2,
            definition = {
                hostId = string.rep("a", 64),
                agentId = target.agentId,
                createdCommandId = M.id(301),
                cwd = "/work/a",
                selection = vim.deepcopy(M.selection),
            },
            launch = launch,
            phase = phase or "ready",
            session = phase == "starting" and vim.NIL or M.snapshot()[1].metadata.session,
            failure = vim.NIL,
        },
        launch = process,
        live = phase == nil or phase == "ready",
        cleanup = "unverified",
        unavailable = vim.NIL,
    }
end

function M.command(target, outcome, command_id, operation)
    local command = command_id or M.id(301)
    local op = operation or (outcome == "restored" and "restore" or outcome == "stopped" and "stop" or "start")
    local input = { commandId = command, handlerGeneration = target.handlerGeneration }
    if op == "start" then
        input.cwd = "/work/a"
        input.selection = vim.deepcopy(M.selection)
        input.environmentDigest = string.rep("a", 64)
    elseif op == "restore" then
        input.agentId = target.agentId
        input.environmentDigest = string.rep("a", 64)
    else
        input.agentId = target.agentId
        input.providerGeneration = target.providerGeneration
    end
    return {
        state = "command",
        durability = "verified",
        command = {
            version = 2,
            hostId = string.rep("a", 64),
            commandId = command,
            handlerGeneration = target.handlerGeneration,
            op = op,
            input = input,
            target = vim.deepcopy(target),
            state = outcome == "pending" and "pending" or "completed",
            result = outcome == "pending" and vim.NIL or {
                outcome = outcome or "started",
                target = vim.deepcopy(target),
                session = M.snapshot()[1].metadata.session,
                failure = vim.NIL,
            },
        },
    }
end

return M