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
    local client = deps.client or require("sodium.agency.control").new()
    local uuid = deps.uuid or require("sodium.agency.control").uuid
    local select_agent = deps.select_agent
        or function(agents, callback)
            vim.ui.select(agents, {
                prompt = "Agency agents",
                format_item = function(view)
                    return view.record.definition.agentId .. " · " .. view.record.phase
                end,
            }, callback)
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
    local report = deps.report or function(value)
        vim.notify("Agency " .. vim.inspect(value))
    end
    local epoch, active, pending, api = 0, nil, {}, {}
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
    local function complete(receipt, envelope, callback, operation)
        local result = envelope.result
        if
            result.state ~= "command"
            or result.command.commandId ~= receipt.commandId
            or result.command.handlerGeneration ~= receipt.handlerGeneration
        then
            callback(error_value("INVALID_PROTOCOL"))
            return
        end
        receipt.view = result
        if result.durability ~= "verified" or result.command.state == "pending" then
            callback(error_value("INCOMPLETE"), result)
            return
        end
        pending[receipt.commandId] = nil
        local outcome = result.command.result
        if not outcome or outcome == null then
            callback(error_value("INVALID_PROTOCOL"))
            return
        end
        if outcome.failure ~= null and outcome.failure ~= nil then
            callback(outcome.failure, result)
            return
        end
        if receipt.op == "stop" then
            if not vim.deep_equal(outcome.target, receipt.target) or outcome.outcome ~= "stopped" then
                callback(error_value("INVALID_PROTOCOL"))
                return
            end
            callback(nil, result)
            return
        end
        if
            outcome.outcome ~= (receipt.op == "start" and "started" or "restored")
            or not outcome.target
            or outcome.target == null
        then
            callback(error_value("INVALID_PROTOCOL"))
            return
        end
        if receipt.agentId and outcome.target.agentId ~= receipt.agentId then
            callback(error_value("INVALID_PROTOCOL"))
            return
        end
        if not valid_operation(operation) then
            report({ state = "created", target = outcome.target, commandId = receipt.commandId })
            callback(error_value("CANCELLED"), result)
            return
        end
        attach(outcome.target, callback, operation, receipt.origin)
    end
    local function dispatch(op, cwd, generation, argv, callback, operation, agent_id, target)
        local receipt = {
            commandId = uuid(),
            handlerGeneration = generation,
            op = op,
            cwd = cwd,
            agentId = agent_id,
            target = target and vim.deepcopy(target),
            epoch = operation,
            origin = vim.deepcopy(current_origin),
        }
        pending[receipt.commandId] = receipt
        vim.list_extend(
            argv,
            {
                "--command-id",
                receipt.commandId,
                op == "stop" and "--handler-generation" or "--expected-handler-generation",
                generation,
            }
        )
        command(argv, cwd, function(error, envelope)
            if error then
                receipt.error = error
                callback(error, envelope)
                return
            end
            complete(receipt, envelope, callback, operation)
        end, 50000)
    end
    local function status(cwd, operation, callback)
        command({ "status" }, cwd, function(error, envelope)
            if not valid_operation(operation) then
                callback(error_value("CANCELLED"))
                return
            end
            if error then
                callback(error)
                return
            end
            if
                envelope.result.phase ~= "ready"
                or not envelope.handlerGeneration
                or envelope.handlerGeneration == null
            then
                callback(error_value("NOT_READY"))
                return
            end
            callback(nil, envelope.handlerGeneration)
        end)
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
        if options.ensure_handler and not operation then
            operation = begin(nil, options.origin)
        end
        local origin = operation and vim.deepcopy(current_origin)
        local ensured, ensured_generation = false, nil
        local attempts = 0
        local function traversal()
            local agents, issues, revision, generation, last_id, cursors = {}, {}, nil, nil, nil, {}
            local function next_page(cursor)
                if finished then return end
                local argv = { "agent", "page", "--limit", "100" }
                if options.cwd then
                    vim.list_extend(argv, { "--cwd", options.cwd })
                end
                if options.active then
                    argv[#argv + 1] = "--active"
                end
                if cursor then
                    vim.list_extend(argv, { "--cursor", cursor })
                end
                local function request(cb)
                    if use_roster then
                        return deps.roster_request({ limit = 100, cwd = options.cwd, cursor = cursor }, cb)
                    end
                    return command(argv, options.cwd or (origin and origin.cwd), cb)
                end
                cancel_request = request(function(error, envelope)
                    if finished then return end
                    cancel_request = nil
                    if operation and not valid_operation(operation) then
                        callback(error_value("CANCELLED"))
                        return
                    end
                    if error then
                        if operation and error.code == "UNAVAILABLE" and not cursor and attempts == 0 and not ensured then
                            ensured = true
                            status(origin.cwd, operation, function(ensure_error, handler_generation)
                                if ensure_error then
                                    callback(ensure_error)
                                    return
                                end
                                ensured_generation = handler_generation
                                traversal()
                            end)
                        elseif error.code == "RESYNC_REQUIRED" and attempts == 0 then
                            attempts = 1
                            traversal()
                        else
                            callback(error)
                        end
                        return
                    end
                    if ensured_generation and envelope.handlerGeneration ~= ensured_generation then
                        callback(error_value("STALE_HANDLER"))
                        return
                    end
                    local page = envelope.result
                    if #page.issues > 0 and not options.allow_issues then
                        callback(error_value("INCOMPLETE"), page)
                        return
                    end
                    if revision and (page.revision ~= revision or envelope.handlerGeneration ~= generation) then
                        callback(error_value("INVALID_PROTOCOL"))
                        return
                    end
                    revision, generation = page.revision, envelope.handlerGeneration
                    vim.list_extend(issues, page.issues)
                    for _, view in ipairs(page.agents) do
                        local record = view.record
                        local agent_id = record.version == 3 and record.definition.agentId or record.spec.agentId
                        local cwd = record.version == 3 and record.definition.cwd or record.spec.checkout.root.path
                        if
                            (last_id and agent_id <= last_id)
                            or (options.cwd and cwd ~= options.cwd)
                            or (
                                options.active
                                and (
                                    record.version ~= 3
                                    or record.launch == null or not record.launch
                                    or record.launch.handlerGeneration ~= generation
                                    or not vim.tbl_contains(
                                        { "ready", "starting", "restoring", "stopping" },
                                        record.phase
                                    )
                                )
                            )
                        then
                            callback(error_value("INVALID_PROTOCOL"))
                            return
                        end
                        agents[#agents + 1] = view
                        last_id = agent_id
                    end
                    if page.nextCursor ~= null and page.nextCursor ~= nil then
                        if use_roster and #page.agents == 0 and #page.issues == 0 then
                            callback(error_value("INVALID_PROTOCOL"))
                            return
                        end
                        if cursors[page.nextCursor] then
                            callback(error_value("INVALID_PROTOCOL"))
                            return
                        end
                        cursors[page.nextCursor] = true
                        next_page(page.nextCursor)
                    else
                        callback(
                            nil,
                            { agents = agents, revision = revision, handlerGeneration = generation, issues = issues }
                        )
                    end
                end)
            end
            next_page()
        end
        traversal()
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
    function api.restore(agent_id, callback, origin)
        local operation = begin(nil, origin)
        local cwd = current_origin.cwd
        status(cwd, operation, function(error, generation)
            if error then
                callback(error)
                return
            end
            dispatch("restore", cwd, generation, { "agent", "restore", agent_id }, callback, operation, agent_id)
        end)
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
            dispatch(
                "stop",
                cwd,
                exact.handlerGeneration,
                { "agent", "stop", exact.agentId, "--provider-generation", exact.providerGeneration },
                callback,
                operation,
                exact.agentId,
                exact
            )
        end)
    end
    function api.inspect_pending(callback)
        local receipts = {}
        for _, value in pairs(pending) do
            receipts[#receipts + 1] = value
        end
        table.sort(receipts, function(a, b)
            return a.commandId < b.commandId
        end)
        if #receipts == 0 then
            callback(nil, {})
            return
        end
        local remaining, results = #receipts, {}
        for _, value in ipairs(receipts) do
            command(
                { "agent", "command", value.commandId, "--handler-generation", value.handlerGeneration },
                value.cwd,
                function(error, envelope)
                    if error then
                        results[#results + 1] = { commandId = value.commandId, error = error }
                        remaining = remaining - 1
                        if remaining == 0 then
                            callback(nil, results)
                        end
                        return
                    end
                    complete(value, envelope, function(failure, target)
                        results[#results + 1] = { commandId = value.commandId, error = failure, result = target }
                        remaining = remaining - 1
                        if remaining == 0 then
                            callback(nil, results)
                        end
                    end, value.epoch)
                end
            )
        end
    end
    function api.attachment()
        return active
    end
    function api.pending()
        return vim.deepcopy(pending)
    end
    function api.detach()
        begin()
        active = nil
        if deps.on_change then
            deps.on_change(nil, nil)
        end
    end
    return api
end

return M