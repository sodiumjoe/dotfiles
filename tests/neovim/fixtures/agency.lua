local M = {}

function M.update(seq, update)
    local event = { kind = "update", seq = seq, replay = false, update = vim.deepcopy(update) }
    event.encodedBytes = #vim.json.encode(event) + 64
    return event
end

function M.projection()
    local frames = M.snapshot()
    local snapshot = vim.deepcopy(frames[1])
    snapshot.events = vim.deepcopy(frames[2].events)
    snapshot.connected = true
    return snapshot
end

function M.view()
    local snapshot, annotations, requests, listeners = M.projection(), {}, {}, {}
    local n = 700
    local controller = {
        snapshot = function()
            return vim.deepcopy(snapshot)
        end,
        subscribe = function(callback)
            listeners[callback] = true
            return function()
                listeners[callback] = nil
            end
        end,
        uuid = function()
            n = n + 1
            return M.id(n)
        end,
        submit = function(id, text, callback)
            requests[#requests + 1] = { id = id, text = text, callback = callback }
        end,
        annotations = function()
            return vim.deepcopy(annotations)
        end,
        accept_annotations = function(captured)
            for _, value in ipairs(captured) do
                for i = #annotations, 1, -1 do
                    if vim.deep_equal(value, annotations[i]) then
                        table.remove(annotations, i)
                    end
                end
            end
        end,
        confirm_external = function(_, _, callback)
            callback(true)
        end,
    }
    local view = require("sodium.agency.agentic_view").new(vim.api.nvim_get_current_tabpage(), controller)
    view.show()
    local function changed()
        for listener in pairs(listeners) do
            listener()
        end
    end
    local function flush()
        vim.wait(100, function()
            return not view.dirty
        end, 1)
    end
    local f = {
        view = view,
        requests = requests,
        controller = controller,
        snapshot = snapshot,
        change = changed,
        add_annotation = function(text)
            annotations[#annotations + 1] = { id = #annotations + 1, revision = 1, text = text }
        end,
        annotation_count = function()
            return #annotations
        end,
        submit = function()
            view.submit(function() end)
        end,
        submit_count = function()
            return #requests
        end,
        delivery_state = function()
            return view.status().delivery
        end,
        set_draft = function(text)
            vim.api.nvim_buf_set_lines(view.widget.buf_nrs.input, 0, -1, false, { text })
        end,
        draft = function()
            return table.concat(vim.api.nvim_buf_get_lines(view.widget.buf_nrs.input, 0, -1, false), "\n")
        end,
        transcript = function()
            return table.concat(vim.api.nvim_buf_get_lines(view.widget.buf_nrs.chat, 0, -1, false), "\n")
        end,
        lose_reply = function()
            requests[1].callback({ code = "HANDLER_UNAVAILABLE" })
        end,
        acknowledge = function()
            requests[1].callback(nil, { submissionId = requests[1].id, state = "accepted" })
        end,
        submitted_event = function()
            snapshot.events[#snapshot.events + 1] =
                { kind = "submitted", seq = 2, submissionId = requests[1].id, text = requests[1].text }
            snapshot.lastSeq = 2
            snapshot.currentTurn = { submissionId = requests[1].id, state = "accepted" }
            changed()
        end,
        reconnect_receipt = function()
            snapshot.currentTurn = { submissionId = requests[1].id, state = "completed" }
            changed()
        end,
        busy = function()
            snapshot.currentTurn = { submissionId = M.id(800), state = "running" }
        end,
        flush = flush,
        close = function()
            view.destroy()
        end,
    }
    return f
end

function M.retention(limits)
    local state = require("sodium.agency.state").new(limits)
    local listeners, views, seq, hook_calls = {}, {}, 0, 0
    local transport = M.client()
    local stream = transport.client.attach(M.target_a, {
        on_frame = function(frame)
            if frame.type == "snapshot_begin" then
                state.begin_snapshot(frame, #vim.json.encode(frame) + 1)
            elseif frame.type == "snapshot_events" then
                state.add_snapshot_events(frame, #vim.json.encode(frame) + 1)
            elseif frame.type == "snapshot_end" then
                state.end_snapshot(frame, #vim.json.encode(frame) + 1)
            elseif frame.type == "event" then
                state.apply_event(frame)
            end
            for callback in pairs(listeners) do
                callback()
            end
        end,
        on_fault = function(err)
            error(vim.inspect(err))
        end,
    })
    transport.deliver(1, M.snapshot(nil, {}))
    local controller = {
        snapshot = state.current,
        limits = limits,
        submit = function()
            hook_calls = hook_calls + 1
            error("rendering dispatched a prompt")
        end,
        accept_annotations = function()
            hook_calls = hook_calls + 1
        end,
        subscribe = function(callback)
            listeners[callback] = true
            return function()
                listeners[callback] = nil
            end
        end,
    }
    for i = 1, 2 do
        views[i] = require("sodium.agency.agentic_view").new(vim.api.nvim_get_current_tabpage(), controller)
    end
    local function deliver(update)
        seq = seq + 1
        transport.deliver(
            1,
            {
                {
                    protocol = "agency-attachment/1",
                    type = "event",
                    target = M.target_a,
                    firstSeq = math.max(1, seq - 127),
                    historyTruncated = seq > 128,
                    event = M.update(seq, update),
                },
            }
        )
    end
    return {
        show = function(i)
            views[i].show()
        end,
        hide = function(i)
            views[i].hide()
        end,
        set_draft = function(i, text)
            vim.api.nvim_buf_set_lines(views[i].widget.buf_nrs.input, 0, -1, false, { text })
        end,
        draft = function(i)
            return table.concat(vim.api.nvim_buf_get_lines(views[i].widget.buf_nrs.input, 0, -1, false), "\n")
        end,
        tool = function(i, text)
            deliver({
                sessionUpdate = "tool_call",
                toolCallId = "tool-" .. i,
                title = "execute",
                kind = "execute",
                status = "in_progress",
                content = { { type = "content", content = { type = "text", text = text } } },
            })
        end,
        update_tool = function(i, text)
            deliver({
                sessionUpdate = "tool_call_update",
                toolCallId = "tool-" .. i,
                status = "completed",
                content = { { type = "content", content = { type = "text", text = text } } },
            })
        end,
        flush = function()
            vim.wait(100, function()
                return not views[1].dirty and not views[2].dirty
            end, 1)
        end,
        projection = state.retention,
        metrics = function(i)
            return views[i].renderer.metrics()
        end,
        has_partial_tool = function(i)
            local block = views[1].renderer.writer.tool_call_blocks["tool-" .. i]
            return block and block.argument:find("partial", 1, true) ~= nil
        end,
        connections = function()
            return #transport.jobs
        end,
        replay_hook_calls = function()
            return hook_calls
        end,
        close = function()
            for _, view in ipairs(views) do
                view.destroy()
            end
            stream.close()
            transport.close()
        end,
    }
end

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

function M.operations(overrides)
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
    local dependencies = {
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
    }
    local operations = require("sodium.agency.operations").new(vim.tbl_extend("force", dependencies, overrides or {}))
    return {
        operations = operations,
        calls = calls,
        streams = streams,
        selections = selections,
        confirmations = confirmations,
        reports = reports,
        respond = function(index, result, error, generation)
            calls[index].callback(error, {
                protocol = "agency-agent/2",
                requestId = M.id(400 + index),
                handlerGeneration = generation or M.target_a.handlerGeneration,
                ok = error == nil,
                result = result,
            })
        end,
        snapshot = function(index)
            for _, frame in ipairs(M.snapshot(streams[index].target)) do
                streams[index].handlers.on_frame(frame, #vim.json.encode(frame) + 1)
            end
        end,
    }
end

function M.commands(overrides)
    local old = package.loaded["sodium.agency"]
    package.loaded["sodium.agency"] = nil
    local agency = require("sodium.agency")
    local f, switches, notices = nil, {}, {}
    agency.setup(vim.tbl_extend("force", {
        operations_factory = function(deps)
            f = M.operations({ on_change = deps.on_change })
            return f.operations
        end,
        confirm_switch = function(callback)
            switches[#switches + 1] = callback
        end,
        notify = function(message)
            notices[#notices + 1] = message
        end,
        uuid = function()
            return M.id(900)
        end,
        confirm_external = function(_, _, callback)
            callback(true)
        end,
    }, overrides or {}))
    f.agency, f.switches, f.notices = agency, switches, notices
    f.close = function()
        agency.detach()
        package.loaded["sodium.agency"] = old
    end
    return f
end

function M.refresh()
    return {
        state = "refresh",
        command = { commandId = M.id(600), handlerGeneration = M.target_a.handlerGeneration, state = "completed", snapshotId = M.id(601) },
        snapshot = { version = 1, hostId = string.rep("a", 64), snapshotId = M.id(601), handlerGeneration = M.target_a.handlerGeneration,
            createdAt = 1000, providers = {} },
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