local M = {}
local null = vim.NIL

local function error_value(code)
    return { code = code, message = code:lower():gsub("_", " ") }
end

local function tuple_of(view)
    local record = view.record
    if record.version ~= 2 then
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
    local client = deps.client or require("sodium.agency.client").new()
    local uuid = deps.uuid or require("sodium.agency.client").uuid
    local select_choice = deps.select_choice
        or function(choices, callback)
            vim.ui.select(choices, {
                prompt = "Agency launch selection",
                format_item = function(choice)
                    return choice.displayName .. " · " .. choice.selection.permissionProfile
                end,
            }, callback)
        end
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
    local epoch, active, candidate, pending, api = 0, nil, nil, {}, {}
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
        if candidate then
            local previous = candidate
            candidate = nil
            previous.stream.close()
            previous.callback(error_value("CANCELLED"))
        end
        return epoch
    end
    local function valid_operation(operation)
        return operation == epoch and vim.api.nvim_tabpage_is_valid(current_origin.tab)
    end
    local function command(argv, cwd, callback, timeout_ms)
        client.command(argv, { cwd = cwd, timeout_ms = timeout_ms or 5000 }, callback)
    end
    local function attach(target, callback, operation, origin)
        if not valid_operation(operation) then
            callback(error_value("CANCELLED"))
            return
        end
        if active and active.state.current().connected and vim.deep_equal(active.target, target) then
            callback(nil, target)
            return
        end
        local called = false
        local original_callback = callback
        callback = function(...)
            if called then
                return
            end
            called = true
            original_callback(...)
        end
        local value = {
            target = vim.deepcopy(target),
            state = require("sodium.agency.state").new(),
            callback = callback,
            origin = vim.deepcopy(origin or current_origin),
        }
        candidate = value
        value.stream = client.attach(target, {
            on_frame = function(frame, bytes)
                if not valid_operation(operation) and candidate == value then
                    candidate = nil
                    value.stream.close()
                    callback(error_value("CANCELLED"))
                    return
                end
                if candidate ~= value and active ~= value then
                    return
                end
                local ok, result = pcall(function()
                    if frame.type == "snapshot_begin" then
                        return value.state.begin_snapshot(frame, bytes)
                    elseif frame.type == "snapshot_events" then
                        return value.state.add_snapshot_events(frame, bytes)
                    elseif frame.type == "snapshot_end" then
                        return value.state.end_snapshot(frame, bytes)
                    elseif frame.type == "event" then
                        return value.state.apply_event(frame)
                    end
                end)
                if not ok then
                    value.stream.close()
                    value.state.disconnect(error_value("INVALID_PROTOCOL"))
                    if candidate == value then
                        candidate = nil
                        callback(error_value("INVALID_PROTOCOL"))
                    end
                    if deps.on_change then
                        deps.on_change(value, nil)
                    end
                    return
                end
                if frame.type == "snapshot_end" then
                    if not valid_operation(operation) then
                        value.stream.close()
                        return
                    end
                    if active then
                        active.stream.close()
                    end
                    active = value
                    candidate = nil
                    callback(nil, vim.deepcopy(target))
                end
                if active == value and deps.on_change then
                    deps.on_change(value, result)
                end
            end,
            on_fault = function(error)
                value.state.disconnect(error)
                if candidate == value then
                    candidate = nil
                    callback(error)
                end
                if active == value and deps.on_change then
                    deps.on_change(value, nil)
                end
            end,
        })
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
            if active and vim.deep_equal(active.target, receipt.target) then
                active.stream.close()
                active.state.disconnect(error_value("NOT_READY"))
                if deps.on_change then
                    deps.on_change(active, nil)
                end
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
    local function launch(cwd, callback, operation)
        status(cwd, operation, function(error, generation)
            if error then
                callback(error)
                return
            end
            command({ "agent", "choices" }, cwd, function(choice_error, envelope)
                if not valid_operation(operation) then
                    callback(error_value("CANCELLED"))
                    return
                end
                if choice_error then
                    callback(choice_error)
                    return
                end
                if envelope.handlerGeneration ~= generation then
                    callback(error_value("STALE_HANDLER"))
                    return
                end
                local result = envelope.result
                if #result.choices == 0 and not deps.allow_empty_choices then
                    callback(error_value("MODEL_UNAVAILABLE"), result)
                    return
                end
                select_choice(result.choices, function(choice)
                    if not valid_operation(operation) then
                        callback(error_value("CANCELLED"))
                        return
                    end
                    if not choice then
                        callback(error_value("CANCELLED"))
                        return
                    end
                    local recognized = false
                    for _, item in ipairs(result.choices) do
                        if vim.deep_equal(item, choice) then
                            recognized = true
                        end
                    end
                    if not recognized then
                        callback(error_value("INVALID_PROTOCOL"))
                        return
                    end
                    local selection = choice.selection
                    local argv = {
                        "agent",
                        "start",
                        "--provider",
                        selection.providerId,
                        "--model",
                        selection.modelId,
                        "--reasoning",
                        selection.reasoning.kind == "none" and "none" or selection.reasoning.value,
                        "--mode",
                        selection.mode,
                        "--permission-profile",
                        selection.permissionProfile,
                    }
                    dispatch("start", cwd, generation, argv, callback, operation)
                end, { cwd = cwd, handlerGeneration = generation, unavailable = result.unavailable })
            end)
        end)
    end
    local function inventory(options, callback, operation)
        options = options or {}
        if options.ensure_handler and not operation then
            operation = begin(nil, options.origin)
        end
        local origin = operation and vim.deepcopy(current_origin)
        local ensured, ensured_generation = false, nil
        local attempts = 0
        local function traversal()
            local agents, issues, revision, generation, last_id, cursors = {}, {}, nil, nil, nil, {}
            local function next_page(cursor)
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
                command(argv, options.cwd or (origin and origin.cwd), function(error, envelope)
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
                        local agent_id = record.version == 2 and record.definition.agentId or record.spec.agentId
                        local cwd = record.version == 2 and record.definition.cwd or record.spec.checkout.root.path
                        if
                            (last_id and agent_id <= last_id)
                            or (options.cwd and cwd ~= options.cwd)
                            or (
                                options.active
                                and (
                                    record.version ~= 2
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
        inventory(options, callback)
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
                launch(origin.cwd, callback, operation)
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
                attach(tuple_of(view), callback, operation, origin)
            end
            if #result.agents == 1 then
                selected(result.agents[1])
            else
                select_agent(result.agents, selected)
            end
        end, operation)
    end
    function api.new(cwd, callback, origin)
        cwd = cwd or vim.fn.getcwd()
        launch(cwd, callback, begin(cwd, origin))
    end
    function api.attach(target, callback, origin)
        attach(vim.deepcopy(target), callback, begin(nil, origin))
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
        elseif active and vim.deep_equal(active.target, exact) then
            local state = active.state.current()
            display.detail = { cwd = state.cwd, model = state.selection.modelId }
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
        if active then
            active.stream.close()
            active = nil
        end
        if deps.on_change then
            deps.on_change(nil, nil)
        end
    end
    return api
end

return M