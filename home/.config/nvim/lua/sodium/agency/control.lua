local M = {}

local function valid_id(value)
    return type(value) == "string"
        and value:match("^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$")
        and value == value:lower()
end

function M.uuid()
    local bytes, parts = assert(vim.uv.random(16)), {}
    for index = 1, 16 do
        local byte = bytes:byte(index)
        if index == 7 then byte = bit.bor(bit.band(byte, 15), 64) end
        if index == 9 then byte = bit.bor(bit.band(byte, 63), 128) end
        parts[index] = string.format("%02x", byte)
    end
    local value = table.concat(parts)
    return value:sub(1, 8) .. "-" .. value:sub(9, 12) .. "-" .. value:sub(13, 16)
        .. "-" .. value:sub(17, 20) .. "-" .. value:sub(21)
end

local function target(value)
    assert(type(value) == "table" and valid_id(value.agentId) and valid_id(value.handlerGeneration) and valid_id(value.providerGeneration))
end

local function host_id(value)
    return type(value) == "string" and #value == 64 and value:match("^[a-f0-9]+$")
end
local function flag(argv, name)
    for index, value in ipairs(argv) do if value == name then return argv[index + 1] end end
end
local function human_receipt(value, argv)
    local expected = flag(argv, "--command-id")
    local raw = flag(argv, "--input-json")
    local input = raw and vim.json.decode(raw) or nil
    expected = expected or input and input.commandId or nil
    if expected and value.protocol == "agency-host/1" then assert(value.commandId == expected) end
    local receipt = value.result.receipt
    if receipt and receipt ~= vim.NIL then
        assert(valid_id(receipt.commandId) and (not expected or receipt.commandId == expected))
        assert(type(receipt.ref) == "table" and host_id(receipt.ref.hostId)); target(receipt.ref.target)
        assert(vim.tbl_contains({ "claimed", "applied", "withdrawn", "stale", "uncertain" }, receipt.state))
        if input then assert(vim.deep_equal(receipt.ref, input.ref) and receipt.optionId == input.optionId) end
        if value.hostId then assert(value.hostId == receipt.ref.hostId) end
    elseif argv[2] == "decide" then error("Missing permission receipt") end
end

local requests = { start = "agent", restore = "agent", stop = "agent", set = "agent", cancel = "agent", prompt = "prompt", agents = "agents",
    excerpt = "excerpt", transcript = "transcript", models = "models", forget = "forgotten", log = "log" }
local activities = { starting = true, idle = true, working = true, stopping = true }

local function present(value) return value ~= nil and value ~= vim.NIL end

function M.row(row)
    assert(type(row) == "table" and valid_id(row.agentId) and type(row.cwd) == "string" and row.cwd:sub(1, 1) == "/")
    assert(vim.tbl_contains({ "codex-acp", "claude-agent-acp" }, row.backendId))
    if present(row.live) then
        assert(type(row.live) == "table" and activities[row.live.activity])
        target({ agentId = row.agentId, handlerGeneration = row.live.handlerGeneration, providerGeneration = row.live.providerGeneration })
    end
    return row
end

function M.view(row)
    local live = present(row.live) and row.live or nil
    local phase = live and ({ starting = "starting", stopping = "stopping" })[live.activity] or (live and "ready" or "stopped")
    local record = { version = 3, definition = { agentId = row.agentId, cwd = row.cwd, backendId = row.backendId }, phase = phase,
        launch = live and { handlerGeneration = live.handlerGeneration, providerGeneration = live.providerGeneration } or vim.NIL,
        settings = live and present(live.model) and { configValues = { model = live.model } } or {},
        title = present(row.title) and row.title or nil, lastActivityAt = present(row.lastActivityAt) and row.lastActivityAt or nil }
    return { record = record, live = live ~= nil, display = live and { title = record.title, activity = live.activity == "working" and "working" or "idle" } or nil }
end

local function excerpt_result(result)
    assert(result.state == "excerpt" and vim.tbl_contains({ "live", "history", "none" }, result.source) and type(result.turns) == "table" and vim.islist(result.turns))
    for _, turn in ipairs(result.turns) do assert((turn.role == "user" or turn.role == "agent") and type(turn.text) == "string") end
end

local function validate_request(value, argv)
    assert(type(value) == "table" and value.protocol == "agency-request/1" and type(value.ok) == "boolean")
    if not value.ok then
        assert(type(value.error) == "table" and type(value.error.code) == "string" and type(value.error.message) == "string")
        return
    end
    local result = value.result
    assert(type(result) == "table" and result.state == requests[argv[1]])
    if result.state == "agent" then M.row(result.agent)
    elseif result.state == "agents" then
        assert(type(result.agents) == "table" and vim.islist(result.agents))
        for _, row in ipairs(result.agents) do M.row(row) end
    elseif result.state == "excerpt" then excerpt_result(result) end
end

local function validate_page(result, generation)
    assert(result.state == "page" and valid_id(result.revision) and type(result.issues) == "table" and vim.islist(result.issues))
    assert(result.nextCursor == vim.NIL or type(result.nextCursor) == "string" and #result.nextCursor <= 4096 and result.nextCursor:match("^[%w_-]+$"))
    assert(type(result.agents) == "table" and vim.islist(result.agents) and #result.agents + #result.issues <= 100)
    for _, view in ipairs(result.agents) do
        assert(type(view.record) == "table")
        if view.record.version == 3 then
            local record = view.record
            assert(type(view.live) == "boolean" and vim.tbl_contains({ "not_launched", "verified", "unverified", "unknown" }, view.cleanup))
            assert(valid_id(record.definition.agentId) and type(record.definition.cwd) == "string" and record.definition.cwd:sub(1, 1) == "/")
            assert(vim.tbl_contains({ "codex-acp", "claude-agent-acp" }, record.definition.backendId) and type(record.settings) == "table")
            assert(vim.tbl_contains({ "starting", "ready", "recoverable", "restoring", "stopping", "stopped", "failed", "interrupted" }, record.phase))
            if record.launch == vim.NIL then assert(not view.live)
            else
                assert(type(record.launch) == "table" and valid_id(record.launch.handlerGeneration) and valid_id(record.launch.providerGeneration))
                if view.live then assert(record.launch.handlerGeneration == generation) end
            end
        else assert(view.record.version == 1) end
    end
end

local function validate(value, argv)
    if requests[argv[1]] then return validate_request(value, argv) end
    local ordinary = argv[1] == "host" or vim.tbl_contains({ "roster", "permission" }, argv[1])
        or argv[1] == "entry" and vim.tbl_contains({ "open", "inspect" }, argv[2])
    local protocol = ordinary and "agency-host/1" or "agency-control/2"
    assert(type(value) == "table" and value.protocol == protocol and valid_id(value.requestId))
    assert(value.handlerGeneration == vim.NIL or valid_id(value.handlerGeneration))
    assert(type(value.ok) == "boolean")
    if not value.ok then
        assert(type(value.error) == "table" and type(value.error.code) == "string"
            and type(value.error.message) == "string")
        return
    end
    local result = value.result
    assert(type(result) == "table")
    if ordinary then
        local expected_state = argv[1] == "host" and (argv[2] == "enroll" and "enrolled" or "hosts")
            or argv[1] == "roster" and (flag(argv, "--host") and (argv[2] == "excerpt" and "excerpt" or "page") or "roster")
            or argv[1] == "permission" and (argv[2] == "list" and "permissions" or "permission")
            or argv[1] == "entry" and "entry"
        assert(result.state == expected_state)
        assert((value.hostId == vim.NIL) == (value.handlerGeneration == vim.NIL))
        assert(value.hostId == vim.NIL or host_id(value.hostId))
        if flag(argv, "--host") then assert(value.hostId == flag(argv, "--host")) end
        if result.state == "roster" then
            assert(value.hostId == vim.NIL and value.handlerGeneration == vim.NIL and host_id(result.localHostId) and type(result.hosts) == "table")
            local seen = {}
            for _, host in ipairs(result.hosts) do
                assert(host_id(host.hostId) and not seen[host.hostId] and type(host.hostname) == "string"); seen[host.hostId] = true
                if host.state == "available" then
                    assert(valid_id(host.value.handlerGeneration) and type(host.value.agents) == "table" and type(host.value.issues) == "table")
                    for _, row in ipairs(host.value.agents) do
                        assert(row.record.version == 3 and row.record.definition.hostId == host.hostId and valid_id(row.record.definition.agentId))
                        assert(type(row.live) == "boolean")
                        if row.live then assert(row.record.launch.handlerGeneration == host.value.handlerGeneration); target({ agentId = row.record.definition.agentId, handlerGeneration = row.record.launch.handlerGeneration, providerGeneration = row.record.launch.providerGeneration }) end
                    end
                else assert(host.state == "unavailable" and type(host.code) == "string") end
            end
        elseif result.state == "permissions" then
            if result.hosts then
                assert(value.hostId == vim.NIL and value.handlerGeneration == vim.NIL and type(result.pending) == "table")
                for _, host in ipairs(result.hosts) do
                    assert(host_id(host.hostId))
                    if host.state == "available" then assert(host.value.hostId == host.hostId and valid_id(host.value.handlerGeneration))
                    else assert(host.state == "unavailable" and type(host.code) == "string") end
                end
            else assert(result.snapshot.hostId == value.hostId and result.snapshot.handlerGeneration == value.handlerGeneration) end
        elseif result.state == "permission" then human_receipt(value, argv)
        elseif result.state == "page" then
            validate_page(result, value.handlerGeneration)
            for _, row in ipairs(result.agents) do assert(row.record.version == 3 and row.record.definition.hostId == value.hostId) end
        elseif result.state == "hosts" then assert(argv[1] == "host" and type(result.hosts) == "table")
        elseif result.state == "enrolled" then assert(argv[1] == "host" and host_id(result.enrollment.hostId))
        elseif result.state == "entry" then
            local receipt = result.receipt
            local raw, expected = flag(argv, "--input-json"), nil
            if raw then expected = vim.json.decode(raw) else expected = { commandId = argv[3] } end
            assert(value.commandId == expected.commandId)
            if receipt ~= vim.NIL then
                assert(type(receipt) == "table" and receipt.commandId == expected.commandId and receipt.ref.hostId == value.hostId)
                target(receipt.ref.target); assert(receipt.state == "stale" or receipt.ref.target.handlerGeneration == value.handlerGeneration)
                if expected.target then assert(vim.deep_equal(receipt.ref, { hostId = expected.hostId, target = expected.target })) end
                assert(vim.tbl_contains({ "opening", "opened", "uncertain", "stale" }, receipt.state))
                if receipt.state == "opened" then
                    assert(type(receipt.editor) == "table" and valid_id(receipt.editor.editorId)
                        and type(receipt.editor.session) == "string" and receipt.editor.session:match("^[%w_-]+$")
                        and type(receipt.editor.pane) == "string" and receipt.editor.pane:match("^%%[0-9]+$")
                        and type(receipt.editor.tmuxSocketPath) == "string" and receipt.editor.tmuxSocketPath:sub(1, 1) == "/")
                end
            end
        elseif result.state == "excerpt" then excerpt_result(result)
        else error("Unexpected host result") end
        return
    end
    if argv[1] == "restart" then
        assert(result.state == "restarted" and type(result.agents) == "table" and vim.islist(result.agents))
        for _, agent in ipairs(result.agents) do
            assert(valid_id(agent.agentId) and vim.tbl_contains({ "restored", "failed", "restoring" }, agent.outcome))
            assert(agent.failure == vim.NIL or type(agent.failure) == "table" and type(agent.failure.code) == "string" and type(agent.failure.message) == "string")
        end
        return
    end
end

M.validate = validate

function M.new(deps)
    deps = deps or {}
    local system, schedule = deps.system or vim.system, deps.schedule or vim.schedule
    local jobs, api = {}, { uuid = M.uuid }
    function api.command(argv, options, callback)
        options = options or {}
        local snapshot_read = argv[1] == "host" and argv[2] == "list"
            or argv[1] == "roster" and argv[2] == "list"
            or argv[1] == "permission" and argv[2] == "list"
        local args = { deps.executable or "agy" }
        vim.list_extend(args, argv)
        args[#args + 1] = "--json"
        local input
        for index, value in ipairs(args) do
            if value == "--input-json" then input = args[index + 1]; args[index + 1] = "-"; break end
        end
        local environment = vim.fn.environ()
        environment.NVIM = vim.v.servername
        local settled, job, timer, chunks, bytes = false, nil, nil, {}, 0
        local function finish(err, result)
            if settled then return end
            settled = true
            if timer then timer:stop(); timer:close() end
            if job then jobs[job] = nil end
            schedule(function() callback(err, result) end)
        end
        local function fail(code)
            if job then pcall(job.kill, job, 15) end
            finish({ code = code, message = code:lower():gsub("_", " ") })
        end
        local ok, handle = pcall(system, args, { cwd = options.cwd or vim.fn.getcwd(), env = environment, stdin = input,
            text = false, stdout = function(err, chunk)
                if settled then return end
                if err then fail("UNAVAILABLE"); return end
                if chunk then
                    bytes = bytes + #chunk
                    if not snapshot_read and bytes > 8388608 then fail("INVALID_PROTOCOL") else chunks[#chunks + 1] = chunk end
                end
            end, stderr = function() end }, function(result)
            if settled then return end
            local raw = #chunks > 0 and table.concat(chunks) or result.stdout or ""
            local valid, value = pcall(function()
                assert(snapshot_read or #raw <= 8388608)
                local decoded = vim.json.decode(raw)
                validate(decoded, argv)
                return decoded
            end)
            if not valid then fail(#raw == 0 and "UNAVAILABLE" or "INVALID_PROTOCOL")
            elseif not value.ok then finish(value.error, value)
            elseif result.code == 0 or result.code == 75 or result.code == 69 and value.result.state == "page" then finish(nil, value)
            else fail("UNAVAILABLE") end
        end)
        if not ok then fail("UNAVAILABLE"); return end
        job = handle
        if not settled then
            jobs[job] = true
            timer = assert(vim.uv.new_timer())
            timer:start(options.timeout_ms or 5000, 0, vim.schedule_wrap(function() fail("UNAVAILABLE") end))
        end
    end
    function api.close()
        for job in pairs(jobs) do pcall(job.kill, job, 15) end
    end
    return api
end

local default
function M.command(...)
    default = default or M.new()
    return default.command(...)
end

return M