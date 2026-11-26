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

function M.failure(code, message)
    return { code = code, message = message or code:lower():gsub("_", " ") }
end

function M.target(view)
    local record = view and view.record
    if not record or not record.launch or record.launch == vim.NIL then return end
    return { agentId = record.definition.agentId, handlerGeneration = record.launch.handlerGeneration,
        providerGeneration = record.launch.providerGeneration }
end

function M.session_id(agent_id) return "agency:" .. agent_id end

function M.agent_id(session_id) return type(session_id) == "string" and session_id:match("^agency:(.+)$") or nil end

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

function M.excerpt(result)
    assert(result.state == "excerpt" and vim.tbl_contains({ "live", "history", "none" }, result.source) and type(result.turns) == "table" and vim.islist(result.turns))
    for _, turn in ipairs(result.turns) do assert((turn.role == "user" or turn.role == "agent") and type(turn.text) == "string") end
end

function M.transcript(result)
    assert(result.state == "transcript" and type(result.turns) == "table" and vim.islist(result.turns) and type(result.truncated) == "boolean")
    assert(result.reason == vim.NIL or type(result.reason) == "string")
    for _, turn in ipairs(result.turns) do assert((turn.role == "user" or turn.role == "agent") and type(turn.text) == "string") end
end

local function validate(value, argv)
    assert(type(value) == "table" and value.protocol == "agency-control/2" and valid_id(value.requestId))
    assert(value.handlerGeneration == vim.NIL or valid_id(value.handlerGeneration))
    assert(type(value.ok) == "boolean")
    if not value.ok then
        assert(type(value.error) == "table" and type(value.error.code) == "string"
            and type(value.error.message) == "string")
        return
    end
    local result = value.result
    assert(type(result) == "table")
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
        local args = { deps.executable or "agy" }
        vim.list_extend(args, argv)
        args[#args + 1] = "--json"
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
            finish(M.failure(code))
        end
        local ok, handle = pcall(system, args, { cwd = options.cwd or vim.fn.getcwd(), env = environment,
            text = false, stdout = function(err, chunk)
                if settled then return end
                if err then fail("UNAVAILABLE"); return end
                if chunk then
                    bytes = bytes + #chunk
                    if bytes > 8388608 then fail("INVALID_PROTOCOL") else chunks[#chunks + 1] = chunk end
                end
            end, stderr = function() end }, function(result)
            if settled then return end
            local raw = #chunks > 0 and table.concat(chunks) or result.stdout or ""
            local valid, value = pcall(function()
                assert(#raw <= 8388608)
                local decoded = vim.json.decode(raw)
                validate(decoded, argv)
                return decoded
            end)
            if not valid then fail(#raw == 0 and "UNAVAILABLE" or "INVALID_PROTOCOL")
            elseif not value.ok then finish(value.error, value)
            elseif result.code == 0 or result.code == 75 then finish(nil, value)
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