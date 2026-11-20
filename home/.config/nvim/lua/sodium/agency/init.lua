local M = {}
local controller
local Context = require("sodium.agency.context")
local Adapter = require("sodium.agency.agentic")

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
    local Registry = require("agentic.session_registry")
    local api = {
        annotations = deps.annotations or Context.annotations, accept_annotations = deps.accept_annotations or Context.accept_annotations,
        notify = deps.notify or function(value, level, opts) vim.notify("Agency: " .. tostring(value), level, opts) end }
    api.deps = deps
    local inventory, epoch, resuming = {}, 0, false
    local function report(err) if err and err.code ~= "CANCELLED" then api.notify(err.message or err.code) end end
    local function local_manager(tab)
        local manager = Registry.sessions[tab or vim.api.nvim_get_current_tabpage()]
        if manager and not manager._agency_destroyed and manager.agent.provider_config == require("agentic.config").acp_providers.agency then return manager end
    end
    local function ready(manager, callback)
        if manager.session_id then callback(nil, manager)
        else manager:on_session_ready(function() callback(nil, manager) end) end
    end
    local function create(opts, callback)
        local manager = Adapter.new_session(opts)
        ready(manager, callback or function() end)
        return manager
    end
    local operations = require("sodium.agency.operations").new({ request = deps.request,
        new_session = create, confirm_stop = deps.confirm_stop })
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
            connected = not manager._agency_destroyed, busy = manager.is_generating }
    end
    function api.current(callback)
        epoch = epoch + 1
        local manager = local_manager()
        if manager then
            if manager.widget:is_open() then manager.widget:hide() else manager.widget:show() end
            if callback then ready(manager, callback) end
            return manager
        end
        operations.current(vim.fn.getcwd(), function(err, result) report(err); if callback then callback(err, result) end end)
    end
    function api.selection_guard(origin)
        epoch = epoch + 1
        operations.detach()
        local captured, tab = epoch, vim.api.nvim_get_current_tabpage()
        origin = origin or Registry.sessions[tab]
        local origin_epoch = origin and origin._agency_epoch
        local function valid()
            return captured == epoch and vim.api.nvim_tabpage_is_valid(tab)
                and Registry.sessions[tab] == origin and (not origin or not origin._agency_destroyed and origin._agency_epoch == origin_epoch)
        end
        return valid, tab
    end
    function api.new(callback, opts)
        local valid, tab = api.selection_guard()
        opts = vim.tbl_extend("force", { cwd = vim.fn.getcwd() }, opts or {})
        if opts.backend_id then return create(opts, callback) end
        require("agentic.acp.agent_instance").get_instance("agency", function(client)
            client:when_ready(function()
                client:request("agency/backends", vim.empty_dict(), vim.schedule_wrap(function(result, err)
                    if not valid() then return end
                    if err or not result or #result.backends == 0 then report(err or failure("UNAVAILABLE")); return end
                    require("sodium.agency.selection").select(result, valid, function(selection)
                        if not valid() then return end
                        vim.api.nvim_set_current_tabpage(tab)
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
    function api.open()
        epoch = epoch + 1
        local manager = local_manager()
        if manager then manager.widget:show(); return manager end
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
        local captured, tab = epoch, vim.api.nvim_get_current_tabpage()
        if type(id) ~= "string" or not id:match("^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$") then report(failure("USAGE")); return end
        if action == "restore" then api.notify("Restoring session " .. id .. "...") end
        api.page({}, function(err, result)
            if captured ~= epoch or not vim.api.nvim_tabpage_is_valid(tab) then
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
                        vim.api.nvim_set_current_tabpage(tab)
                        local ok, manager = pcall(Adapter.open, row, { force = true })
                        if ok then if callback then callback(nil, manager) end; return end
                        err = { code = "FAILED", message = "Session " .. id .. " was not restored: " .. tostring(manager) }
                    elseif row.live and row.record.phase == "ready" and tuple(row) then
                        operations.attach(tuple(row), function(error, manager) report(error); if callback then callback(error, manager) end end,
                            { tab = tab, buffer = vim.api.nvim_get_current_buf(), cwd = row.record.definition.cwd })
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
        local binding, tab = vim.deepcopy(manager._agency_binding), manager.tab_page_id
        if not binding or resuming then return end
        api.page({}, function(err, result)
            if err or not vim.api.nvim_tabpage_is_valid(tab) or not vim.deep_equal(manager._agency_binding, binding) then return end
            for _, row in ipairs(result.agents) do
                if row.record.version == 3 and row.record.definition.agentId == binding.agentId then
                    local live = row.live and row.record.phase == "ready" and tuple(row)
                    if live and vim.deep_equal(live, binding) then return end
                    vim.api.nvim_set_current_tabpage(tab)
                    if live then
                        api.notify("This tab was bound to an earlier run of its agent; reattaching. Send the prompt again once it loads")
                        api.attach(binding.agentId)
                    else
                        api.notify("This tab's agent is stopped; restoring it. Send the prompt again once it is attached")
                        api.restore(binding.agentId)
                    end
                    return
                end
            end
        end)
    end
    function api.detach(tab)
        epoch = epoch + 1
        operations.detach()
        local manager = local_manager(tab)
        if manager then Registry.destroy_session(manager.tab_page_id) end
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
        local tab, lifecycle_epoch = manager and manager.tab_page_id, manager and manager._agency_lifecycle_epoch
        operations.stop(exact, function(err)
            report(err)
            if not err and manager and local_manager(tab) == manager
                and manager._agency_lifecycle_epoch == lifecycle_epoch and vim.deep_equal(manager._agency_binding, exact) then
                api.detach(tab)
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
        local manager = local_manager(captured.tab)
        if manager then add(nil, manager)
        else operations.current(captured.cwd, add, { tab = captured.tab, buffer = captured.buffer, cwd = captured.cwd }) end
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
            if not manager:can_submit_prompt() then callback({ state = "rejected", error = failure("NOT_READY") }); return false end
            local content = {}
            for _, item in ipairs(annotations) do content[#content + 1] = { type = "text", text = item.text } end
            local entry = Adapter.stage_context(manager, content, function(submissionId)
                api.accept_annotations(annotations)
                callback({ state = "accepted", submissionId = submissionId })
            end, function(error) callback({ state = "rejected", error = error }) end)
            if not manager:_handle_input_submit(text) then
                Adapter.unstage_context(manager, entry)
                callback({ state = "rejected", error = failure("NOT_READY") })
                return false
            end
            return true
        end
        local manager = local_manager(opts.tab)
        if manager and manager.session_id then return send(nil, manager) end
        if opts.tab then callback({ state = "rejected", error = failure("NOT_READY") }); return false end
        operations.current(vim.fn.getcwd(), function(err, result) if err then send(err) else ready(result, send) end end)
        return true
    end
    function api.view_for_buffer(buf)
        for tab, manager in pairs(Registry.sessions) do
            if vim.api.nvim_tabpage_is_valid(tab) and not manager._agency_destroyed then
                for _, owned in pairs(manager.widget.buf_nrs) do if owned == buf then return manager end end
            end
        end
    end
    function api.permissions()
        local manager = local_manager()
        if not manager then api.notify("A local Agency attachment is required"); return end
        manager._agency_routed_permissions = manager._agency_routed_permissions or require("sodium.agency.permissions").new({ notify = api.notify })
        manager._agency_routed_permissions.open()
    end
    function api.busy()
        if operations.in_flight() > 0 then return true end
        local agency = require("agentic.config").acp_providers.agency
        for _, manager in pairs(Registry.sessions) do
            if not manager._agency_destroyed and manager.agent.provider_config == agency
                and (manager._agency_load_pending or manager._agency_new_pending or manager._agency_intent) then return true end
        end
        return false
    end
    function api.resume()
        if resuming or vim.g.agency_reload_running then return end
        local Rebind = require("sodium.agency.rebind")
        local open = {}
        for _, manager in ipairs(Rebind.managers()) do open[#open + 1] = manager.session_id:sub(8) end
        if #open == 0 then return end
        resuming = true
        local progress = { id = "agency_resume", title = "Agency" }
        api.notify("The Agency Handler connection ended; reconnecting…", vim.log.levels.INFO, vim.tbl_extend("force", progress, { timeout = false }))
        local deadline = vim.uv.now() + (deps.resume_timeout_ms or 30000)
        local function settled(result)
            local live = {}
            for _, row in ipairs(result.agents) do
                if row.record.version == 3 and row.live and row.record.phase == "ready" then live[row.record.definition.agentId] = true end
            end
            for _, id in ipairs(open) do if not live[id] then return false end end
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
                    local text = summary.timed_out and "the editor did not reconnect; reopen tabs with <leader>af" or Rebind.describe(summary)
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