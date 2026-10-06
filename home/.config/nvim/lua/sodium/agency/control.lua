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

local function validate(value, argv)
    local protocol = argv[1] == "agent" and "agency-agent/3"
        or argv[1] == "model" and "agency-catalog/1" or "agency-control/2"
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
    if argv[1] ~= "agent" then return end
    if result.state == "command" then
        local command = result.command
        assert(type(command) == "table" and command.version == 3 and valid_id(command.commandId)
            and command.commandId == value.commandId and valid_id(command.handlerGeneration)
            and valid_id(command.agentId) and (result.durability == "verified" or result.durability == "unverified"))
        assert(command.state == "pending" or command.state == "completed" or command.state == "interrupted")
        if argv[2] == "command" then assert(command.commandId == argv[3]) end
        if command.result ~= vim.NIL and command.result ~= nil then
            local outcome = command.result
            assert(type(outcome) == "table" and vim.tbl_contains({ "started", "restored", "stopped", "imported", "failed", "interrupted" }, outcome.outcome))
            if outcome.target ~= vim.NIL and outcome.target ~= nil then
                target(outcome.target)
                assert(outcome.target.agentId == command.agentId and outcome.target.handlerGeneration == command.handlerGeneration)
            end
            if vim.tbl_contains({ "started", "restored", "stopped" }, outcome.outcome) then assert(type(outcome.target) == "table") end
        end
        if argv[2] ~= "command" then assert(command.op == argv[2]) end
        if argv[2] == "restore" or argv[2] == "stop" then assert(command.agentId == argv[3]) end
        for index, flag in ipairs(argv) do
            if flag == "--command-id" then assert(command.commandId == argv[index + 1]) end
            if flag == "--handler-generation" or flag == "--expected-handler-generation" then assert(command.handlerGeneration == argv[index + 1]) end
        end
    else
        local states = { list = "agents", page = "page", choices = "choices", current = "current" }
        assert(states[argv[2]] == result.state)
        if result.state == "page" then
            assert(valid_id(result.revision) and type(result.issues) == "table" and vim.islist(result.issues))
            assert(result.nextCursor == vim.NIL or type(result.nextCursor) == "string" and #result.nextCursor <= 4096 and result.nextCursor:match("^[%w_-]+$"))
            assert(#result.agents + #result.issues <= 100)
        end
        if result.agents then
            assert(type(result.agents) == "table" and vim.islist(result.agents))
            for _, view in ipairs(result.agents) do
                assert(type(view.record) == "table")
                if view.record.version == 3 then
                    local record = view.record
                    assert(type(view.live) == "boolean" and vim.tbl_contains({ "not_launched", "verified", "unverified", "unknown" }, view.cleanup))
                    assert(valid_id(record.definition.agentId) and type(record.definition.cwd) == "string" and record.definition.cwd:sub(1, 1) == "/")
                    assert(vim.tbl_contains({ "codex-acp", "claude-agent-acp" }, record.definition.backendId) and type(record.settings) == "table")
                    assert(vim.tbl_contains({ "starting", "ready", "recoverable", "restoring", "stopping", "stopped" }, record.phase))
                    if record.launch == vim.NIL then assert(not view.live)
                    else
                        assert(type(record.launch) == "table" and valid_id(record.launch.handlerGeneration) and valid_id(record.launch.providerGeneration))
                        if view.live then assert(record.launch.handlerGeneration == value.handlerGeneration) end
                    end
                else assert(view.record.version == 1) end
            end
        end
    end
end

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
            finish({ code = code, message = code:lower():gsub("_", " ") })
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