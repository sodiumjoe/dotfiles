local M = {}
local controller
local Context = require("sodium.agency.context")

local function failure(code) return { code = code, message = code:lower():gsub("_", " ") } end
local function tuple(row)
    local record = row and row.record
    if not record or record.version ~= 3 or not record.launch or record.launch == vim.NIL then return end
    return { agentId = record.definition.agentId, handlerGeneration = record.launch.handlerGeneration,
        providerGeneration = record.launch.providerGeneration }
end

function M.commands(api)
    local commands = { AgencyPermissions = { "permissions", 0 }, Agency = { "roster", 0 }, AgencyCurrent = { "current", 0 }, AgencyNew = { "new", 0 },
        AgencyOpen = { "open", 0 }, AgencyAttach = { "attach", 1 }, AgencyRestore = { "restore", 1 },
        AgencySettings = { "settings", 0 }, AgencyDetach = { "detach", 0 }, AgencyCancel = { "cancel", 0 }, AgencyStop = { "stop", 0 }, AgencyInspect = { "inspect_delivery", 0 } }
    for name, spec in pairs(commands) do
        vim.api.nvim_create_user_command(name, function(args)
            if spec[2] == 1 then api[spec[1]](args.args) else api[spec[1]]() end
        end, { nargs = spec[2], force = true, complete = spec[2] == 1 and function(prefix)
            local ids = {}
            for _, row in ipairs(api.inventory()) do
                local id = row.record.version == 3 and row.record.definition.agentId
                if id and id:sub(1, #prefix) == prefix then ids[#ids + 1] = id end
            end
            return ids
        end or nil })
    end
    vim.api.nvim_create_user_command("AgencyReload", function(args)
        require("sodium.agency.reload").run({ force = args.bang })
    end, { bang = true, force = true })
end

function M.setup(deps)
    if controller then return controller end
    deps = deps or {}
    require("sodium.agency.layout").setup()
    require("sodium.agency.screen").setup()
    local Registry = require("agentic.session_registry")
    local api = {
        annotations = deps.annotations or Context.annotations, accept_annotations = deps.accept_annotations or Context.accept_annotations,
        notify = deps.notify or function(value, level, opts) vim.notify("Agency: " .. tostring(value), level, opts) end }
    api.deps = deps
    local inventory, epoch, resuming = {}, 0, false
    local Rebind = require("sodium.agency.rebind")
    local function report(err) if err and err.code ~= "CANCELLED" then api.notify(err.message or err.code) end end
    local function client() return require("agentic.acp.agent_instance").get_instance("agency") end
    local function local_manager(key)
        local manager
        if key then manager = Registry.get(key) else manager = Registry.current() end
        if Rebind.agency(manager) then return manager end
    end
    local function ready(manager, callback)
        if manager.session_id then callback(nil, manager)
        else manager:on_session_ready(function() callback(nil, manager) end) end
    end
    local function start(spec, agent, focus)
        local source, tab = Registry.visible_here(), vim.api.nvim_get_current_tabpage()
        local anchor = source and source.widget:find_first_non_widget_window(tab)
        local function place(fn)
            if anchor and require("agentic.utils.buf_helpers").is_win_usable(anchor) then return pcall(vim.api.nvim_win_call, anchor, fn) end
            if vim.api.nvim_get_current_tabpage() == tab then return pcall(fn) end
            return true
        end
        local target = Registry.create("agency", spec, agent)
        if not target then return end
        function target._agency_restore()
            if not source or Registry.get(source.session_key) ~= source or source.widget:is_open() then return end
            local ok, err = place(function()
                if Registry.visible_here() then return end
                Registry.set_most_recent(source.session_key)
                Registry.show_session(source.session_key, { focus_prompt = false })
            end)
            if not ok then api.notify("The previous session could not be shown again: " .. tostring(err)) end
        end
        if source then Registry.set_most_recent(source.session_key) else target.widget.size = target.widget.size or {} end
        local shown, err = place(function() Registry.show_session(target.session_key, focus == false and { focus_prompt = false } or nil) end)
        if not shown then
            Registry.destroy(target.session_key)
            target._agency_restore()
            api.notify("The new session could not be shown: " .. tostring(err))
            return
        end
        require("sodium.agency.screen").resize()
        target:on_session_ready(function() end, target._agency_restore)
        return target
    end
    local function create(opts, callback)
        local agent = assert(client(), "Agency is not configured")
        require("sodium.agency.layout").cleanup()
        local cwd = opts.cwd
        local meta = { backend_id = opts.backend_id, selection = opts.selection, environment = opts.environment }
        local manager = start({ kind = "new", cwd = cwd and function() return cwd end, meta = meta }, agent, opts.focus)
        if not manager then
            if callback then callback({ code = "FAILED", message = "the session could not be shown" }) end
            return
        end
        ready(manager, callback or function() end)
        return manager
    end
    local function reveal(target)
        if target then
            target:on_session_ready(function()
                if Registry.get(target.session_key) == target and not target.widget:is_open() then Registry.show_session(target.session_key) end
            end)
        end
        return target
    end
    local function open(row, focus)
        local record = assert(row.record)
        assert(record.version == 3, "Unavailable legacy Agency session")
        local id, agent = "agency:" .. record.definition.agentId, assert(client(), "Agency is not configured")
        local manager = Rebind.holder(id, agent)
        if manager then
            if Rebind.dead(manager, tuple(row)) then return reveal(Rebind.reattach(manager, row)) end
            Registry.show_session(manager.session_key, focus == false and { focus_prompt = false } or nil)
            return manager
        end
        local pending = Registry.find_by_acp_session_id(id, agent)
        if pending then return pending end
        require("sodium.agency.layout").cleanup()
        return start({ kind = "load", session_id = id, cwd = record.definition.cwd, title = record.definition.backendId, meta = { backend_id = record.definition.backendId } }, agent, focus)
    end
    local function start_error(manager) return Rebind.reason(manager._agency_start_error) end
    local operations = require("sodium.agency.operations").new({ request = deps.request,
        new_session = create, open = open, confirm_stop = deps.confirm_stop })
    api.operations = operations
    api.enter_remote = deps.enter_remote or require("sodium.agency.remote").new({ client = deps.client, notify = api.notify }).enter
    api.read_roster = deps.roster or function(callback)
        local Roster = require("sodium.agency.roster")
        ;(deps.request or Roster.request)("agency/remotes", vim.empty_dict(), function(err, envelope)
            if err then callback(err); return end
            callback(nil, Roster.hosts(envelope.result))
        end, { timeout_ms = 10000 })
    end
    function api.excerpt(excerpt, callback)
        local params = { agentId = excerpt.agentId, turns = 4, hostId = excerpt.hostId }
        ;(deps.request or require("sodium.agency.roster").request)("agency/excerpt", params, function(err, envelope) callback(err, envelope and envelope.result) end, { timeout_ms = 10000 })
    end
    function api.snapshot()
        local manager = local_manager()
        if not manager or not manager._agency_binding then return end
        return { target = vim.deepcopy(manager._agency_binding), cwd = manager._agency_cwd,
            connected = not manager._agency_unavailable, busy = manager.is_generating }
    end
    function api.current(callback)
        epoch = epoch + 1
        local manager = local_manager()
        if manager then
            require("sodium.agency.screen").cycle()
            if callback then ready(manager, callback) end
            return manager
        end
        operations.current(vim.fn.getcwd(), function(err, result) report(err); if callback then callback(err, result) end end)
    end
    function api.selection_guard(origin)
        epoch = epoch + 1
        operations.detach()
        local captured = epoch
        origin = origin or Registry.current()
        local function valid() return captured == epoch and Registry.current() == origin end
        return valid, origin and origin.session_key
    end
    function api.new(callback, opts)
        local valid = api.selection_guard()
        opts = vim.tbl_extend("force", { cwd = vim.fn.getcwd() }, opts or {})
        if opts.backend_id then return create(opts, callback) end
        require("agentic.acp.agent_instance").get_instance("agency", function(agent)
            agent:when_ready(function()
                agent:request("agency/backends", vim.empty_dict(), vim.schedule_wrap(function(result, err)
                    if not valid() then return end
                    if err or not result or #result.backends == 0 then report(err or failure("UNAVAILABLE")); return end
                    require("sodium.agency.selection").select(result, valid, function(selection)
                        if not valid() then return end
                        create(vim.tbl_extend("force", opts, selection), callback)
                    end)
                end))
            end)
        end)
    end
    function api.settings()
        local manager = local_manager()
        if not manager or not manager.session_id or not manager._agency_binding then report(failure("NOT_READY")); return end
        local valid = api.selection_guard(manager)
        require("sodium.agency.selection").settings(manager.config_options, valid, api.notify)
    end
    function api.open(row)
        if row then return open(row) end
        epoch = epoch + 1
        local manager = local_manager()
        if manager then Registry.show_session(manager.session_key); return manager end
        return api.current()
    end
    function api.page(options, callback)
        operations.page(options, function(err, result)
            if not err then inventory = vim.deepcopy(result.agents) end
            callback(err, result)
        end)
    end
    local function selected(id, callback, action, expected)
        epoch = epoch + 1
        operations.detach()
        local captured = epoch
        if type(id) ~= "string" or not id:match("^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$") then report(failure("USAGE")); return end
        if action == "restore" then api.notify("Restoring session " .. id .. "...") end
        api.page({}, function(err, result)
            if captured ~= epoch then
                if action == "restore" then
                    api.notify("Restore of session " .. id .. " cancelled before it started.")
                    if callback then callback(failure("CANCELLED")) end
                end
                return
            end
            if err then report(err); if callback then callback(err) end; return end
            for _, row in ipairs(result.agents) do
                if row.record.version == 3 and row.record.definition.agentId == id then
                    if expected and not vim.deep_equal(tuple(row), tuple(expected)) then err = failure("STALE_PROVIDER")
                    elseif action == "restore" then
                        local ok, manager = pcall(open, row)
                        if ok and not manager then ok, manager = false, "the session could not be started" end
                        if ok then
                            manager:on_session_ready(function() end, function()
                                api.notify("Session " .. id .. " was not restored: " .. start_error(manager))
                            end)
                            if callback then callback(nil, manager) end
                            return
                        end
                        err = { code = "FAILED", message = "Session " .. id .. " was not restored: " .. tostring(manager) }
                    elseif row.live and row.record.phase == "ready" and tuple(row) then
                        operations.attach(tuple(row), function(error, manager) report(error); if callback then callback(error, manager) end end,
                            { buffer = vim.api.nvim_get_current_buf(), cwd = row.record.definition.cwd })
                        return
                    else err = failure("NOT_READY") end
                    report(err); if callback then callback(err) end; return
                end
            end
            report(failure("UNAVAILABLE"))
        end)
    end
    function api.attach(id, callback, expected) selected(id, callback, "attach", expected) end
    function api.restore(id, callback) selected(id, callback, "restore") end
    function api.recover(manager)
        local current, key = vim.deepcopy(manager._agency_binding), manager.session_key
        local id = current and current.agentId or manager._agency_unavailable and type(manager.session_id) == "string" and manager.session_id:match("^agency:(.+)$")
        if not id or resuming then return end
        api.page({}, function(err, result)
            if err or Registry.get(key) ~= manager or not vim.deep_equal(manager._agency_binding, current) then return end
            for _, row in ipairs(result.agents) do
                if row.record.version == 3 and row.record.definition.agentId == id then
                    local live = row.live and row.record.phase == "ready" and tuple(row)
                    if live and vim.deep_equal(live, current) then return end
                    if live and current then api.notify("This session was bound to an earlier run of its agent; reattaching. Send the prompt again once it loads")
                    elseif live then api.notify("This session lost its connection to its agent; reattaching. Send the prompt again once it loads")
                    else api.notify("This session's agent is stopped; restoring it. Send the prompt again once it is attached") end
                    local ok, target = pcall(Rebind.reattach, manager, row)
                    if ok and not target then ok, target = false, "the session could not be started" end
                    if ok then reveal(target) else api.notify("Session " .. id .. " was not reattached: " .. tostring(target)) end
                    return
                end
            end
            Rebind.gone(manager)
        end)
    end
    function api.detach(key)
        epoch = epoch + 1
        operations.detach()
        local manager = local_manager(key)
        if not manager then return end
        local restore = not manager.session_id and manager._agency_restore
        Registry.destroy(manager.session_key)
        if restore then restore() end
    end
    function api.cancel()
        epoch = epoch + 1
        local manager = local_manager()
        if manager then manager.agent:stop_generation(manager.session_id) end
    end
    function api.stop(row)
        epoch = epoch + 1
        local snapshot = api.snapshot()
        local exact = row and tuple(row) or snapshot and snapshot.target
        if not exact then report(failure("NOT_READY")); return end
        local manager = local_manager()
        local key, bound = manager and manager.session_key, manager and vim.deep_equal(manager._agency_binding, exact)
        operations.stop(exact, function(err)
            report(err)
            if not err and manager and local_manager(key) == manager and (vim.deep_equal(manager._agency_binding, exact)
                or bound and manager._agency_unavailable and manager._agency_binding == nil) then
                api.detach(key)
            end
        end, { cwd = row and row.record.definition.cwd or snapshot.cwd })
    end
    function api.roster() epoch = epoch + 1; return require("sodium.agency.picker").open(api) end
    function api.inspect_delivery() operations.inspect_pending(function(err, result) report(err); api.notify(vim.inspect(result)) end) end
    local function with_context(captured, kind)
        local function add(err, manager)
            if err then report(err); return end
            Context.add(manager, captured, kind)
            manager.widget:show({ focus_prompt = false })
        end
        local manager = local_manager()
        if manager then add(nil, manager)
        else operations.current(captured.cwd, add, { buffer = captured.buffer, cwd = captured.cwd }, false) end
    end
    function api.add_context() epoch = epoch + 1; with_context(Context.capture(vim.api.nvim_get_current_buf(), vim.fn.mode())) end
    function api.add_diagnostics(scope)
        epoch = epoch + 1
        local captured = Context.capture(vim.api.nvim_get_current_buf())
        if scope == "line" then
            local line = vim.api.nvim_win_get_cursor(0)[1] - 1
            captured.diagnostics = vim.tbl_filter(function(item) return item.lnum == line end, captured.diagnostics)
        end
        with_context(captured, "diagnostics")
    end
    function api.submit_text(text, opts, callback)
        epoch = epoch + 1
        opts, callback = opts or {}, callback or function(result) report(result.error) end
        local annotations = opts.annotations and vim.deepcopy(api.annotations()) or {}
        if opts.annotations and #annotations == 0 then callback({ state = "rejected", error = failure("EMPTY_INPUT") }); return false end
        local function send(err, manager)
            if err then callback({ state = "rejected", error = err }); return false end
            if manager._agency_gone then callback({ state = "rejected", error = { code = "GONE", message = Rebind.GONE } }); return false end
            if not manager:can_submit_prompt() then callback({ state = "rejected", error = failure("NOT_READY") }); return false end
            local content = {}
            for _, item in ipairs(annotations) do content[#content + 1] = { type = "text", text = item.text } end
            local entry = Context.stage(manager, content, function(submissionId)
                api.accept_annotations(annotations)
                callback({ state = "accepted", submissionId = submissionId })
            end, function(error) callback({ state = "rejected", error = error }) end)
            if not manager.widget.on_submit_input(text) then
                Context.unstage(manager, entry)
                callback({ state = "rejected", error = failure("NOT_READY") })
                return false
            end
            return true
        end
        local manager = local_manager(opts.session)
        if manager and manager.session_id then return send(nil, manager) end
        if opts.session then callback({ state = "rejected", error = failure("NOT_READY") }); return false end
        operations.current(vim.fn.getcwd(), function(err, result) if err then send(err) else ready(result, send) end end, nil, false)
        return true
    end
    function api.view_for_buffer(buf)
        local widget = require("agentic.ui.widget_registry").get(buf)
        local manager = widget and widget.session_key and Registry.get(widget.session_key)
        if Rebind.agency(manager) then return manager end
    end
    function api.permissions()
        local manager = local_manager()
        if not manager then api.notify("A local Agency attachment is required"); return end
        manager._agency_routed_permissions = manager._agency_routed_permissions or require("sodium.agency.permissions").new({ notify = api.notify })
        manager._agency_routed_permissions.open()
    end
    function api.busy(force)
        if operations.in_flight() > 0 then return "stop" end
        if force then return false end
        for _, manager in ipairs(Registry.list()) do
            if Rebind.agency(manager) and (manager._agency_load_pending or manager._agency_new_pending) then return "start" end
        end
        return false
    end
    function api.resume()
        if resuming or vim.g.agency_reload_running then return end
        local attached = {}
        for _, manager in ipairs(Rebind.managers()) do attached[#attached + 1] = manager.session_id:sub(8) end
        if #attached == 0 then return end
        resuming = true
        local progress = { id = "agency_resume", title = "Agency" }
        api.notify("The Agency Handler connection ended; reconnecting…", vim.log.levels.INFO, vim.tbl_extend("force", progress, { timeout = false }))
        local deadline = vim.uv.now() + (deps.resume_timeout_ms or 30000)
        local function settled(result)
            local live = {}
            for _, row in ipairs(result.agents) do
                if row.record.version == 3 and row.live and row.record.phase == "ready" then live[row.record.definition.agentId] = true end
            end
            for _, id in ipairs(attached) do if not live[id] then return false end end
            return true
        end
        local function attempt()
            api.page({}, function(err, result)
                if (err or not settled(result)) and vim.uv.now() < deadline then vim.defer_fn(attempt, deps.resume_retry_ms or 1000); return end
                if err then
                    resuming = false
                    api.notify("The Agency Handler is unavailable (" .. (err.message or err.code) .. "); run :AgencyReload", vim.log.levels.WARN, progress)
                    return
                end
                Rebind.run(result.agents, { reconnect = deps.reconnect }, function(summary)
                    resuming = false
                    local text = summary.timed_out and "the editor did not reconnect; reopen sessions with <leader>af" or Rebind.describe(summary)
                    api.notify("Reconnected to the Agency Handler: " .. text, vim.log.levels.INFO, progress)
                end)
            end)
        end
        vim.defer_fn(attempt, deps.resume_delay_ms or 1000)
    end
    function api.inventory() return inventory end
    controller = api
    M.commands(api)
    return api
end

for _, name in ipairs({ "current", "new", "settings", "open", "attach", "restore", "detach", "cancel", "stop", "roster",
    "add_context", "add_diagnostics", "submit_text" }) do M[name] = function(...) return M.setup()[name](...) end end
function M.view_for_buffer(buf) return controller and controller.view_for_buffer(buf) end
return M