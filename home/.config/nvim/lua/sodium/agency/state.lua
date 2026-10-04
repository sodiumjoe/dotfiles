local M = {}
local null = vim.NIL

local function integer(value, minimum)
    return type(value) == "number"
        and value == math.floor(value)
        and value >= (minimum or 0)
        and value <= 9007199254740991
end

local function estimate(value)
    if type(value) == "string" then
        return #value + 32
    end
    if type(value) ~= "table" then
        return 16
    end
    local bytes = 96
    for key, child in pairs(value) do
        bytes = bytes + 64 + estimate(key) + estimate(child)
    end
    return bytes
end

local function deque()
    return { values = {}, head = 1, tail = 0, bytes = 0 }
end

local function count(q)
    return q.tail - q.head + 1
end

local function remove(q)
    local item = q.values[q.head]
    q.values[q.head] = nil
    q.head = q.head + 1
    q.bytes = q.bytes - item.bytes
end

local function list(q)
    local values = {}
    for index = q.head, q.tail do
        values[#values + 1] = q.values[index].event
    end
    return values
end

local function title(value)
    local length = math.min(#value, 1024)
    if length < #value then
        while length > 0 and value:byte(length + 1) >= 128 and value:byte(length + 1) < 192 do
            length = length - 1
        end
    end
    return { title = value:sub(1, length), titleTruncated = length < #value, titleOriginalBytes = #value }
end

function M.new(options)
    options = options or {}
    local max_bytes, max_events = options.history_bytes or 16777216, options.history_events or 8192
    assert(integer(max_bytes, 1) and max_bytes <= 16777216 and integer(max_events, 1) and max_events <= 8192)
    local current, stage
    local api = {}
    local function fail()
        stage = nil
        if current then
            current.connected = false
            current.failure = { code = "INVALID_PROTOCOL" }
        end
        error("INVALID_PROTOCOL", 0)
    end
    local function checked(condition)
        if not condition then
            fail()
        end
    end
    local function bound(frame, wire_bytes)
        checked(integer(wire_bytes, 1) and wire_bytes <= 2097152)
        checked(frame.firstSeq == nil or integer(frame.firstSeq, 1))
        checked(frame.lastSeq == nil or integer(frame.lastSeq))
    end
    local function charge(frame, wire_bytes)
        bound(frame, wire_bytes)
        stage.wire_bytes = stage.wire_bytes + wire_bytes
        checked(stage.wire_bytes <= 17825792)
    end
    local function append(q, event)
        checked(integer(event.seq, 1) and integer(event.encodedBytes, 1) and event.encodedBytes <= 2097152)
        local bytes = math.max(event.encodedBytes, #vim.json.encode(event), estimate(event))
        q.tail = q.tail + 1
        q.values[q.tail] = { event = vim.deepcopy(event), bytes = bytes }
        q.bytes = q.bytes + bytes
        local evicted = 0
        while q.bytes > max_bytes or count(q) > max_events do
            remove(q)
            evicted = evicted + 1
        end
        if q.head > 16384 then
            local values = {}
            for index = q.head, q.tail do
                values[#values + 1] = q.values[index]
            end
            q.values = values
            q.head = 1
            q.tail = #values
        end
        return evicted
    end
    local function update_metadata(value, event)
        local metadata = value.metadata
        if event.kind == "lifecycle" then
            for _, key in ipairs({ "phase", "session", "selection", "cwd", "failure" }) do
                if event[key] ~= nil then
                    metadata[key] = vim.deepcopy(event[key])
                end
            end
        elseif event.kind == "submitted" or event.kind == "turn" then
            value.currentTurn = event.kind == "submitted" and { submissionId = event.submissionId, state = "accepted" }
                or { submissionId = event.submissionId, state = event.state }
        elseif event.kind == "update" then
            local update = event.update
            if update.sessionUpdate == "session_info_update" and type(update.title) == "string" then
                metadata.title = title(update.title)
            elseif update.sessionUpdate == "usage_update" then
                metadata.usage =
                    { used = update.used, size = update.size, cost = update.cost and vim.deepcopy(update.cost) }
            elseif update.sessionUpdate == "plan" then
                metadata.plan = {}
                metadata.planTruncated = false
                local bytes = 2
                for _, entry in ipairs(update.entries) do
                    local size = #vim.json.encode(entry) + 1
                    if bytes + size > 16384 then
                        metadata.planTruncated = true
                        break
                    end
                    metadata.plan[#metadata.plan + 1] = vim.deepcopy(entry)
                    bytes = bytes + size
                end
            end
        end
        checked(#vim.json.encode(metadata) <= 65536)
    end
    function api.begin_snapshot(frame, wire_bytes)
        checked(stage == nil and frame.type == "snapshot_begin")
        bound(frame, wire_bytes)
        checked(integer(frame.firstSeq, 1) and integer(frame.lastSeq) and frame.firstSeq <= frame.lastSeq + 1)
        checked(type(frame.historyTruncated) == "boolean" and (frame.historyTruncated or frame.firstSeq == 1))
        checked(type(frame.metadata) == "table" and #vim.json.encode(frame.metadata) <= 65536)
        stage = {
            begin = vim.deepcopy(frame),
            queue = deque(),
            expected = frame.firstSeq,
            chunks = 0,
            total = 0,
            wire_bytes = 0,
            truncated = frame.historyTruncated,
        }
        charge(frame, wire_bytes)
    end
    function api.add_snapshot_events(frame, wire_bytes)
        checked(
            stage ~= nil
                and frame.type == "snapshot_events"
                and vim.deep_equal(frame.target, stage.begin.target)
                and frame.snapshotId == stage.begin.snapshotId
        )
        charge(frame, wire_bytes)
        checked(frame.chunkIndex == stage.chunks and type(frame.events) == "table" and #frame.events > 0)
        stage.chunks = stage.chunks + 1
        for _, event in ipairs(frame.events) do
            checked(event.seq == stage.expected and event.seq <= stage.begin.lastSeq)
            stage.expected = stage.expected + 1
            stage.total = stage.total + 1
            checked(stage.total <= 8192)
            if append(stage.queue, event) > 0 then
                stage.truncated = true
            end
        end
    end
    function api.end_snapshot(frame, wire_bytes)
        checked(
            stage ~= nil
                and frame.type == "snapshot_end"
                and vim.deep_equal(frame.target, stage.begin.target)
                and frame.snapshotId == stage.begin.snapshotId
        )
        charge(frame, wire_bytes)
        local start = stage.begin
        checked(
            frame.firstSeq == start.firstSeq
                and frame.lastSeq == start.lastSeq
                and frame.historyTruncated == start.historyTruncated
                and frame.chunkCount == stage.chunks
                and stage.expected == start.lastSeq + 1
        )
        current = {
            target = start.target,
            sessionId = start.sessionId,
            cwd = start.cwd,
            selection = start.selection,
            metadata = start.metadata,
            limits = start.limits,
            currentTurn = start.currentTurn,
            queue = stage.queue,
            lastSeq = start.lastSeq,
            handlerFirst = start.firstSeq,
            handlerTruncated = start.historyTruncated,
            truncated = stage.truncated,
            connected = true,
        }
        stage = nil
        return api.current()
    end
    function api.apply_event(frame)
        checked(current ~= nil and current.connected and stage == nil and vim.deep_equal(frame.target, current.target))
        local event = frame.event
        checked(
            type(event) == "table"
                and integer(event.seq, 1)
                and integer(event.encodedBytes, 1)
                and event.encodedBytes <= 2097152
        )
        checked(
            integer(frame.firstSeq, 1)
                and frame.firstSeq >= current.handlerFirst
                and frame.firstSeq <= event.seq + 1
                and type(frame.historyTruncated) == "boolean"
                and (frame.historyTruncated or frame.firstSeq == 1)
                and (not current.handlerTruncated or frame.historyTruncated)
        )
        if event.seq <= current.lastSeq then
            local retained
            for index = current.queue.head, current.queue.tail do
                if current.queue.values[index].event.seq == event.seq then
                    retained = current.queue.values[index].event
                    break
                end
            end
            checked(retained ~= nil and vim.deep_equal(retained, event))
            local evicted = 0
            while count(current.queue) > 0 and current.queue.values[current.queue.head].event.seq < frame.firstSeq do
                remove(current.queue)
                evicted = evicted + 1
            end
            current.handlerFirst = frame.firstSeq
            current.handlerTruncated = frame.historyTruncated
            current.truncated = current.truncated or frame.historyTruncated or evicted > 0
            return {
                appended = false,
                evicted = evicted,
                first_seq = api.retention().first_seq,
                last_seq = current.lastSeq,
            }
        end
        checked(event.seq == current.lastSeq + 1)
        update_metadata(current, event)
        local evicted = append(current.queue, event)
        while count(current.queue) > 0 and current.queue.values[current.queue.head].event.seq < frame.firstSeq do
            remove(current.queue)
            evicted = evicted + 1
        end
        current.lastSeq = event.seq
        current.handlerFirst = frame.firstSeq
        current.handlerTruncated = frame.historyTruncated
        current.truncated = current.truncated or frame.historyTruncated or evicted > 0
        return { appended = true, evicted = evicted, first_seq = api.retention().first_seq, last_seq = current.lastSeq }
    end
    function api.disconnect(failure)
        stage = nil
        if current then
            current.connected = false
            current.failure = failure
        end
    end
    function api.current()
        if not current then
            return nil
        end
        return vim.deepcopy({
            target = current.target,
            sessionId = current.sessionId,
            cwd = current.cwd,
            selection = current.selection,
            metadata = current.metadata,
            currentTurn = current.currentTurn,
            limits = current.limits,
            events = list(current.queue),
            connected = current.connected,
            failure = current.failure,
            historyTruncated = current.truncated,
            firstSeq = api.retention().first_seq,
            lastSeq = current.lastSeq,
        })
    end
    function api.retention()
        if not current then
            return { bytes = 0, events = 0, first_seq = 1, last_seq = 0, truncated = false }
        end
        local q = current.queue
        return {
            bytes = q.bytes,
            events = count(q),
            first_seq = count(q) > 0 and q.values[q.head].event.seq or current.lastSeq + 1,
            last_seq = current.lastSeq,
            truncated = current.truncated,
        }
    end
    return api
end

return M