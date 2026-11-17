local M = {}
local null = vim.NIL

local function error_value(code)
    return { code = code, message = code:lower():gsub("_", " ") }
end

local function tuple_of(view)
    local record = view.record
    if record.version ~= 3 or not record.launch or record.launch == null then
        return nil
    end
    return {
        agentId = record.definition.agentId,
        handlerGeneration = record.launch.handlerGeneration,
        providerGeneration = record.launch.providerGeneration,
    }
end

function M.new(deps)
    deps = deps or {}
    local Control = require("sodium.agency.control")
    local client = deps.client or Control.new()
    local select_agent = deps.select_agent
        or function(agents, callback)
            return require("sodium.agency.picker").current(agents, callback)
        end
    local confirm_stop = deps.confirm_stop
        or function(target, callback)
            local detail = target.detail or {}
            vim.ui.select(
                { "Stop", "Keep running" },
                {
                    prompt = table.concat(
                        {
                            "Stop Agency agent",
                            target.agentId,
                            target.handlerGeneration,
                            target.providerGeneration,
                            detail.model or "",
                            detail.cwd or "",
                        },
                        "\n"
                    ),
                },
                function(value)
                    callback(value == "Stop")
                end
            )
        end
    local epoch, active, pending, sequence, api = 0, nil, {}, 0, {}
    local current_origin
    local function begin(cwd, origin)
        epoch = epoch + 1
        current_origin = {
            tab = vim.api.nvim_get_current_tabpage(),
            buffer = vim.api.nvim_get_current_buf(),
            cwd = cwd or vim.fn.getcwd(),
        }
        if origin then
            current_origin = vim.deepcopy(origin)
        end
        return epoch
    end
    local function valid_operation(operation)
        return operation == epoch and vim.api.nvim_tabpage_is_valid(current_origin.tab)
    end
    local function command(argv, cwd, callback, timeout_ms)
        client.command(argv, { cwd = cwd, timeout_ms = timeout_ms or 5000 }, callback)
    end
    local function request(op, agent_id, argv, cwd, callback)
        sequence = sequence + 1
        local key = sequence
        pending[key] = { op = op, agentId = agent_id, cwd = cwd, startedAt = os.date("!%Y-%m-%dT%H:%M:%SZ") }
        command(argv, cwd, function(error, envelope)
            pending[key] = nil
            callback(error, envelope)
        end, 310000)
    end
    local inventory
    local function attach(target, callback, operation, origin)
        inventory({ allow_issues = true }, function(err, result)
            if not valid_operation(operation) then callback(error_value("CANCELLED")); return end
            if err then callback(err); return end
            for _, row in ipairs(result.agents) do
                if row.record.version == 3 and row.record.definition.agentId == target.agentId then
                    if not row.live or row.record.phase ~= "ready" or not tuple_of(row) then callback(error_value("NOT_READY")); return end
                    if not vim.deep_equal(tuple_of(row), target) then callback(error_value("STALE_PROVIDER")); return end
                    vim.api.nvim_set_current_tabpage(origin.tab)
                    local manager = (deps.open or require("sodium.agency.agentic").open)(row)
                    active = manager
                    manager:on_session_ready(function()
                        if not valid_operation(operation) then callback(error_value("CANCELLED")); return end
                        callback(nil, manager)
                    end)
                    return
                end
            end
            callback(error_value("UNAVAILABLE"))
        end, operation)
    end
    inventory = function(options, callback, operation, use_roster)
        options = options or {}
        local finished, timer, cancel_request = false, nil, nil
        local complete = callback
        callback = function(err, result)
            if finished then return end
            finished = true
            if timer then timer:stop(); timer:close() end
            if cancel_request then cancel_request() end
            complete(err, result)
        end
        if use_roster then
            timer = assert(vim.uv.new_timer())
            timer:start(deps.roster_timeout_ms or 10000, 0, vim.schedule_wrap(function()
                callback(error_value("UNAVAILABLE"))
            end))
        end
        local origin = operation and vim.deepcopy(current_origin) or { cwd = options.cwd or vim.fn.getcwd() }
        local function received(error, envelope)
            if finished then return end
            cancel_request = nil
            if operation and not valid_operation(operation) or options.alive and not options.alive() then
                callback(error_value("CANCELLED"))
                return
            end
            if error then callback(error); return end
            local result = envelope.result
            local generation = result.handlerGeneration ~= null and result.handlerGeneration or nil
            local agents = {}
            for _, row in ipairs(result.agents) do
                local live = row.live ~= nil and row.live ~= null
                if (not options.cwd or row.cwd == options.cwd) and (not options.active or live) then agents[#agents + 1] = Control.view(row) end
            end
            table.sort(agents, function(a, b) return a.record.definition.agentId < b.record.definition.agentId end)
            callback(nil, { agents = agents, revision = generation, handlerGeneration = generation, issues = {} })
        end
        if use_roster then
            cancel_request = deps.roster_request(options.cwd and { cwd = options.cwd } or vim.empty_dict(), received)
        else
            command({ "agents" }, options.cwd or origin.cwd, received, 10000)
        end
    end
    function api.page(options, callback)
        inventory(options, callback, nil, options and options.active and deps.roster_request)
    end
    function api.current(cwd, callback, captured)
        cwd = cwd or vim.fn.getcwd()
        local operation = begin(cwd, captured)
        local origin = vim.deepcopy(current_origin)
        inventory({ cwd = cwd, active = true }, function(error, result)
            if not valid_operation(operation) then
                callback(error_value("CANCELLED"))
                return
            end
            if error then
                callback(error, result)
                return
            end
            if #result.agents == 0 then
                (deps.new_session or function(opts, done)
                    local manager = require("sodium.agency.agentic").new_session(opts)
                    manager:on_session_ready(function() done(nil, manager) end)
                end)({ cwd = origin.cwd }, callback)
                return
            end
            local function selected(view)
                if not valid_operation(operation) then
                    callback(error_value("CANCELLED"))
                    return
                end
                if not view then
                    callback(error_value("CANCELLED"))
                    return
                end
                if not view.live or view.record.phase ~= "ready" then
                    callback(error_value("NOT_READY"), view)
                    return
                end
                vim.api.nvim_set_current_tabpage(origin.tab)
                local manager = (deps.open or require("sodium.agency.agentic").open)(view)
                active = manager
                manager:on_session_ready(function()
                    if valid_operation(operation) then callback(nil, manager) else callback(error_value("CANCELLED")) end
                end)
            end
            if #result.agents == 1 then
                selected(result.agents[1])
            else
                select_agent(result.agents, selected)
            end
        end, operation)
    end
    function api.attach(target, callback, origin)
        local operation = begin(nil, origin)
        attach(vim.deepcopy(target), callback, operation, vim.deepcopy(current_origin))
    end
    function api.load(row, callback, origin)
        begin(nil, origin)
        vim.api.nvim_set_current_tabpage(current_origin.tab)
        local ok, manager = pcall(deps.open or require("sodium.agency.agentic").open, row, { force = true })
        if not ok then
            callback({ code = "FAILED", message = "Session " .. row.record.definition.agentId .. " was not restored: " .. tostring(manager) })
            return
        end
        active = manager
        callback(nil, manager)
    end
    function api.stop(target, callback, detail)
        local operation, cwd, exact = begin(), vim.fn.getcwd(), vim.deepcopy(target)
        local display = vim.deepcopy(exact)
        if detail then
            display.detail = vim.deepcopy(detail)
        end
        confirm_stop(display, function(confirmed)
            if not valid_operation(operation) then
                callback(error_value("CANCELLED"))
                return
            end
            if not confirmed then
                callback(error_value("CANCELLED"))
                return
            end
            request("stop", exact.agentId, { "stop", exact.agentId }, cwd, function(error, envelope)
                if error then callback(error, envelope); return end
                callback(nil, envelope.result)
            end)
        end)
    end
    function api.inspect_pending(callback)
        local requests = {}
        for _, value in pairs(pending) do
            requests[#requests + 1] = vim.deepcopy(value)
        end
        table.sort(requests, function(a, b)
            return a.startedAt < b.startedAt
        end)
        callback(nil, requests)
    end
    function api.detach()
        begin()
        active = nil
    end
    function api.in_flight()
        return vim.tbl_count(pending)
    end
    return api
end

return M