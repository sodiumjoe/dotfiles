local M = {}
local controller
local Context = require("sodium.agency.context")
local Client = require("sodium.agency.client")

local function failure(code)
    return { code = code, message = code:lower():gsub("_", " ") }
end

local function tuple(row)
    local record = row and row.record
    if not record or record.version ~= 2 then
        return nil
    end
    return {
        agentId = record.definition.agentId,
        handlerGeneration = record.launch.handlerGeneration,
        providerGeneration = record.launch.providerGeneration,
    }
end

local function is_busy(snapshot)
    local turn = snapshot and snapshot.currentTurn
    return turn and turn ~= vim.NIL and (turn.state == "accepted" or turn.state == "running") or false
end

local function valid_id(id)
    return type(id) == "string"
        and id:match("^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$")
end

local function annotation_capture()
    local ok, store = pcall(require, "comment-overlay.store")
    if not ok then
        return {}
    end
    store.reload_if_changed()
    local project, items = store.get_project_root(), {}
    for _, file in ipairs(store.get_files_with_comments()) do
        for _, root in ipairs(store.get_for_file(file, { roots_only = true })) do
            if not root.resolved then
                local thread = vim.deepcopy(store.get_thread(root.id))
                local lines =
                    { "File: " .. project .. "/" .. file, "Line: " .. tostring(root.line_start or root.line or "?") }
                for _, comment in ipairs(thread) do
                    lines[#lines + 1] = comment.body
                end
                items[#items + 1] = {
                    id = root.id,
                    project = project,
                    path = project .. "/" .. file,
                    thread = thread,
                    text = table.concat(lines, "\n"),
                }
            end
        end
    end
    return items
end

local function annotation_accept(captured)
    if #captured == 0 then
        return
    end
    local store = require("comment-overlay.store")
    store.reload_if_changed()
    local project = store.get_project_root()
    for _, item in ipairs(captured) do
        if project == item.project and vim.deep_equal(store.get_thread(item.id), item.thread) then
            store.delete(item.id)
        end
    end
    pcall(vim.cmd, "CommentRefresh")
end

function M.setup(deps)
    if controller then
        return controller
    end
    deps = deps or {}
    local client = deps.client or Client.new()
    local views, listeners, inventory = {}, {}, {}
    local epoch, direct, last_attachment, completed_seq, metadata = 0, nil, nil, 0, nil
    local api = {}
    api.notify = deps.notify
        or function(message)
            vim.notify("Agency: " .. tostring(message), vim.log.levels.INFO)
        end
    api.uuid = deps.uuid or Client.uuid
    api.confirm_external = deps.confirm_external or Context.confirm_external
    api.annotations = deps.annotations or annotation_capture
    api.accept_annotations = deps.accept_annotations or annotation_accept
    api.timer_factory = deps.timer_factory
    local function accept_direct(value)
        if not value.accepted then
            value.accepted = true
            api.accept_annotations(value.annotations)
        end
    end
    local operations
    function api.snapshot()
        local active = operations.attachment()
        return active and active.state.current()
    end
    function api.metadata()
        return metadata and vim.deepcopy(metadata)
    end
    local function changed(active, delta)
        if active ~= last_attachment then
            last_attachment, completed_seq = active, 0
        end
        local snapshot = api.snapshot()
        metadata = snapshot
            and {
                cwd = snapshot.cwd,
                selection = vim.deepcopy(snapshot.selection),
                connected = snapshot.connected,
                currentTurn = vim.deepcopy(snapshot.currentTurn),
                metadata = { usage = vim.deepcopy(snapshot.metadata.usage) },
            }
        if direct and snapshot and vim.deep_equal(direct.target, snapshot.target) then
            local turn = snapshot.currentTurn
            if turn and turn ~= vim.NIL and turn.submissionId == direct.id then
                accept_direct(direct)
            end
        end
        if delta and delta.appended and snapshot then
            local event = snapshot.events[#snapshot.events]
            if
                event
                and event.kind == "turn"
                and (event.state == "completed" or event.state == "failed")
                and not event.replay
                and event.seq > completed_seq
            then
                completed_seq = event.seq
                api.notify("turn " .. event.state)
            end
        end
        for callback in pairs(listeners) do
            callback()
        end
    end
    operations = (deps.operations_factory or require("sodium.agency.operations").new)({
        client = client,
        uuid = api.uuid,
        on_change = changed,
        report = function(value)
            api.notify(vim.inspect(value))
        end,
        select_choice = function(choices, callback, info)
            require("sodium.agency.picker").choices(client, choices, info, callback, api)
        end,
        allow_empty_choices = true,
    })
    api.operations = operations
    function api.subscribe(callback)
        listeners[callback] = true
        return function()
            listeners[callback] = nil
        end
    end
    local function report(err)
        if err and err.code ~= "CANCELLED" then
            api.notify(err.message or err.code)
        end
    end
    local function view(tab)
        if not vim.api.nvim_tabpage_is_valid(tab) then
            return nil
        end
        if views[tab] and views[tab].status().destroyed then
            views[tab] = nil
        end
        if not views[tab] then
            views[tab] = (deps.view_factory or require("sodium.agency.agentic_view").new)(tab, api)
        end
        return views[tab]
    end
    local function show(tab, toggle, opts)
        if not api.snapshot() then
            report(failure("NOT_READY"))
            return
        end
        local value = view(tab)
        if value then
            if toggle then
                value.toggle()
            else
                value.show(opts or { focus_prompt = true })
            end
        end
    end
    local function drafts()
        for _, value in pairs(views) do
            if value.has_draft() then
                return true
            end
        end
        return false
    end
    local function lifecycle(run, callback, toggle, origin, opts)
        epoch = epoch + 1
        local operation = epoch
        origin = origin
            or {
                tab = vim.api.nvim_get_current_tabpage(),
                buffer = vim.api.nvim_get_current_buf(),
                cwd = vim.fn.getcwd(),
            }
        local function execute(confirmed)
            if operation ~= epoch or not vim.api.nvim_tabpage_is_valid(origin.tab) or not confirmed then
                if callback then
                    callback(failure("CANCELLED"))
                end
                return
            end
            run(
                origin.cwd,
                function(err, target)
                    if operation ~= epoch or not vim.api.nvim_tabpage_is_valid(origin.tab) then
                        if callback then
                            callback(failure("CANCELLED"))
                        end
                        return
                    end
                    if not err then
                        direct = nil
                        show(origin.tab, toggle, opts)
                    end
                    report(err)
                    if callback then
                        callback(err, target)
                    end
                end,
                origin,
                function()
                    return operation == epoch and vim.api.nvim_tabpage_is_valid(origin.tab)
                end
            )
        end
        if drafts() then
            (deps.confirm_switch or function(done)
                vim.ui.select(
                    { "Switch target", "Keep target" },
                    { prompt = "Agency views contain unsent drafts or context" },
                    function(choice)
                        done(choice == "Switch target")
                    end
                )
            end)(execute)
        else
            execute(true)
        end
    end
    function api.current(callback)
        if api.snapshot() then
            show(vim.api.nvim_get_current_tabpage(), true)
            if callback then
                callback(nil, api.snapshot().target)
            end
            return
        end
        lifecycle(operations.current, callback, true)
    end
    function api.new(callback)
        lifecycle(operations.new, callback)
    end
    function api.open()
        show(vim.api.nvim_get_current_tabpage())
    end
    function api.page(options, callback)
        operations.page(options, function(err, result)
            if not err then
                inventory = vim.deepcopy(result.agents)
            end
            callback(err, result)
        end)
    end
    local function selected(id, callback, action, expected)
        if not valid_id(id) then
            report(failure("USAGE"))
            if callback then
                callback(failure("USAGE"))
            end
            return
        end
        lifecycle(function(_, done, origin, alive)
            api.page({ allow_issues = true, ensure_handler = action == "restore", origin = origin }, function(err, result)
                if not alive() then
                    done(failure("CANCELLED"))
                    return
                end
                if err then
                    done(err)
                    return
                end
                for _, row in ipairs(result.agents) do
                    if tuple(row) and row.record.definition.agentId == id then
                        if expected and not vim.deep_equal(tuple(row), tuple(expected)) then
                            done(failure("STALE_PROVIDER"))
                            return
                        end
                        if action == "restore" then
                            if
                                row.cleanup == "verified"
                                and vim.tbl_contains({ "stopped", "recoverable" }, row.record.phase)
                            then
                                operations.restore(id, done, origin)
                            else
                                done(failure("CLEANUP_UNVERIFIED"))
                            end
                        elseif row.live and row.record.phase == "ready" then
                            operations.attach(tuple(row), done, origin)
                        else
                            done(failure("NOT_READY"))
                        end
                        return
                    end
                end
                done(failure("UNAVAILABLE"))
            end)
        end, callback)
    end
    function api.attach(id, callback, expected)
        selected(id, callback, "attach", expected)
    end
    function api.restore(id, callback)
        selected(id, callback, "restore")
    end
    function api.detach()
        epoch = epoch + 1
        operations.detach()
        for _, value in pairs(views) do
            value.destroy()
        end
        views, direct = {}, nil
    end
    local function request(body, callback, exact)
        local active = operations.attachment()
        local snapshot = api.snapshot()
        if
            not active
            or not snapshot
            or not snapshot.connected
            or (exact and not vim.deep_equal(exact, active.target))
        then
            callback(failure("NOT_READY"))
            return
        end
        active.stream.request(body, function(err, frame)
            callback(err, frame and frame.receipt)
        end)
    end
    function api.submit(id, text, callback, exact)
        request({ op = "submit", submissionId = id, text = text }, callback, exact)
    end
    function api.inspect(id, callback, exact)
        request({ op = "inspect-submission", submissionId = id }, function(err, receipt)
            if not err and receipt and receipt ~= vim.NIL and direct and direct.id == id then
                accept_direct(direct)
            end
            callback(err, receipt)
        end, exact)
    end
    function api.inspect_delivery()
        if direct and not direct.accepted then
            api.inspect(direct.id, function(err, receipt)
                report(err)
                if receipt and receipt ~= vim.NIL then
                    api.notify("submission " .. receipt.state)
                end
            end, direct.target)
        end
        for _, value in pairs(views) do
            value.inspect(report)
        end
        operations.inspect_pending(function(err, result)
            report(err)
            if result and #result > 0 then
                api.notify(vim.inspect(result))
            end
        end)
    end
    function api.cancel()
        local snapshot = api.snapshot()
        if not is_busy(snapshot) then
            report(failure("NOT_READY"))
            return
        end
        request({ op = "cancel", submissionId = snapshot.currentTurn.submissionId }, report, snapshot.target)
    end
    function api.stop(row)
        epoch = epoch + 1
        local snapshot = api.snapshot()
        local exact = row and tuple(row) or snapshot and snapshot.target
        if not exact then
            report(failure("NOT_READY"))
            return
        end
        local detail = row and { cwd = row.record.definition.cwd, model = row.record.definition.selection.modelId }
            or { cwd = snapshot.cwd, model = snapshot.selection.modelId }
        operations.stop(exact, report, detail)
    end
    function api.roster()
        return require("sodium.agency.picker").open(api)
    end
    local function add(captured, kind)
        local origin = { tab = captured.tab, buffer = captured.buffer, cwd = captured.cwd }
        local function completed(err)
            if not err and vim.api.nvim_tabpage_is_valid(origin.tab) then
                local value = view(origin.tab)
                value.add_context(captured, kind)
                value.show({ focus_prompt = false })
            end
        end
        if api.snapshot() then
            completed()
        else
            lifecycle(operations.current, completed, false, origin)
        end
    end
    function api.add_context()
        add(Context.capture(vim.api.nvim_get_current_buf(), vim.fn.mode()))
    end
    function api.add_diagnostics(scope)
        local captured = Context.capture(vim.api.nvim_get_current_buf())
        if scope == "line" then
            local line = vim.api.nvim_win_get_cursor(0)[1] - 1
            captured.diagnostics = vim.tbl_filter(function(item)
                return item.lnum == line
            end, captured.diagnostics)
        end
        add(captured, "diagnostics")
    end
    function api.submit_text(text, opts, callback)
        opts, callback = opts or {}, callback or function(result)
            report(result.error)
        end
        local origin =
            { tab = vim.api.nvim_get_current_tabpage(), buffer = vim.api.nvim_get_current_buf(), cwd = vim.fn.getcwd() }
        local annotations = opts.annotations and vim.deepcopy(api.annotations()) or {}
        if opts.annotations and #annotations == 0 then
            callback({ state = "rejected", error = { code = "EMPTY_INPUT", message = "no unresolved annotations" } })
            return false
        end
        local encoded, err = Context.encode(text, {}, {}, annotations)
        if not encoded then
            callback({ state = "rejected", error = err })
            return false
        end
        local function send(lifecycle_error)
            if lifecycle_error then
                callback({ state = "rejected", error = lifecycle_error })
                return
            end
            local snapshot = api.snapshot()
            if not snapshot or not snapshot.connected or is_busy(snapshot) or (direct and not direct.accepted) then
                callback({ state = "rejected", error = failure("NOT_READY") })
                return
            end
            local value = { id = api.uuid(), target = vim.deepcopy(snapshot.target), annotations = annotations }
            direct = value
            api.confirm_external(snapshot.cwd, annotations, function(confirmed)
                if direct ~= value then
                    callback({ state = "rejected", error = failure("CANCELLED") })
                    return
                end
                if not confirmed then
                    direct = nil
                    callback({ state = "rejected", error = failure("CANCELLED") })
                    return
                end
                request({ op = "submit", submissionId = value.id, text = encoded }, function(error, receipt)
                    if not error and receipt and receipt ~= vim.NIL and receipt.submissionId == value.id then
                        accept_direct(value)
                    end
                    if value.accepted then
                        callback({ state = "accepted", receipt = receipt, submissionId = value.id })
                    elseif
                        error
                        and (
                            error.rejected
                            or vim.tbl_contains(
                                { "NOT_READY", "STALE_HANDLER", "STALE_PROVIDER", "INPUT_TOO_LARGE" },
                                error.code
                            )
                        )
                    then
                        if direct == value then
                            direct = nil
                        end
                        callback({ state = "rejected", error = error })
                    else
                        callback({ state = "unknown", error = error, submissionId = value.id })
                    end
                end, value.target)
            end)
        end
        if api.snapshot() then
            send()
        else
            lifecycle(operations.current, send, false, origin, { focus_prompt = opts.focus_prompt ~= false })
        end
        return true
    end
    function api.view_for_buffer(buf)
        for tab, value in pairs(views) do
            if vim.api.nvim_tabpage_is_valid(tab) and not value.destroyed then
                for _, owned in pairs(value.widget.buf_nrs) do
                    if owned == buf then
                        return value
                    end
                end
            end
        end
    end
    controller = api
    local commands = {
        Agency = { "roster", "0" },
        AgencyCurrent = { "current", "0" },
        AgencyNew = { "new", "0" },
        AgencyOpen = { "open", "0" },
        AgencyAttach = { "attach", "1" },
        AgencyRestore = { "restore", "1" },
        AgencyDetach = { "detach", "0" },
        AgencyCancel = { "cancel", "0" },
        AgencyStop = { "stop", "0" },
        AgencyInspect = { "inspect_delivery", "0" },
    }
    for name, spec in pairs(commands) do
        vim.api.nvim_create_user_command(
            name,
            function(args)
                if spec[2] == "1" then
                    api[spec[1]](args.args)
                else
                    api[spec[1]]()
                end
            end,
            {
                nargs = tonumber(spec[2]),
                force = true,
                complete = spec[2] == "1" and function(prefix)
                    local ids = {}
                    for _, row in ipairs(inventory) do
                        local id = tuple(row) and row.record.definition.agentId
                        if id and id:sub(1, #prefix) == prefix then
                            ids[#ids + 1] = id
                        end
                    end
                    return ids
                end or nil,
            }
        )
    end
    local group = vim.api.nvim_create_augroup("SodiumAgency", { clear = true })
    vim.api.nvim_create_autocmd("VimLeavePre", { group = group, callback = api.detach })
    vim.api.nvim_create_autocmd("TabClosed", {
        group = group,
        callback = function()
            for tab, value in pairs(views) do
                if not vim.api.nvim_tabpage_is_valid(tab) then
                    value.destroy()
                    views[tab] = nil
                end
            end
        end,
    })
    return api
end

for _, name in ipairs({
    "current",
    "new",
    "open",
    "attach",
    "restore",
    "detach",
    "cancel",
    "stop",
    "roster",
    "add_context",
    "add_diagnostics",
    "submit_text",
}) do
    M[name] = function(...)
        return M.setup()[name](...)
    end
end

function M.view_for_buffer(buf)
    return controller and controller.view_for_buffer(buf)
end

return M