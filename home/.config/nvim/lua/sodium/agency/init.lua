local M = {}
local controller
local Context = require("sodium.agency.context")
local Adapter = require("sodium.agency.agentic")
local Control = require("sodium.agency.control")

local function failure(code) return { code = code, message = code:lower():gsub("_", " ") } end
local function tuple(row)
    local record = row and row.record
    if not record or record.version ~= 3 or not record.launch or record.launch == vim.NIL then return end
    return { agentId = record.definition.agentId, handlerGeneration = record.launch.handlerGeneration,
        providerGeneration = record.launch.providerGeneration }
end

function M.setup(deps)
    if controller then return controller end
    deps = deps or {}
    Adapter.install()
    local Registry = require("agentic.session_registry")
    local api = { uuid = Control.uuid, timer_factory = deps.timer_factory,
        annotations = deps.annotations or Context.annotations, accept_annotations = deps.accept_annotations or Context.accept_annotations,
        notify = deps.notify or function(value) vim.notify("Agency: " .. tostring(value)) end }
    local inventory, epoch = {}, 0
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
    local operations = require("sodium.agency.operations").new({ client = deps.client, uuid = api.uuid,
        report = api.notify, new_session = create, confirm_stop = deps.confirm_stop,
        roster_request = deps.roster_request or (not deps.client and require("sodium.agency.roster").new()) })
    api.operations = operations
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
                client:_send_request("agency/backends", vim.empty_dict(), vim.schedule_wrap(function(result, err)
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
        api.page({ allow_issues = true, ensure_handler = action == "restore" }, function(err, result)
            if captured ~= epoch or not vim.api.nvim_tabpage_is_valid(tab) then return end
            if err then report(err); if callback then callback(err) end; return end
            for _, row in ipairs(result.agents) do
                if row.record.version == 3 and row.record.definition.agentId == id then
                    if expected and not vim.deep_equal(tuple(row), tuple(expected)) then err = failure("STALE_PROVIDER")
                    elseif action == "restore" then
                        if (row.cleanup == "verified" or row.cleanup == "not_launched")
                            and vim.tbl_contains({ "stopped", "recoverable" }, row.record.phase) then
                            operations.restore(id, function(error, manager) report(error); if callback then callback(error, manager) end end,
                                { tab = tab, buffer = vim.api.nvim_get_current_buf(), cwd = row.record.definition.cwd })
                            return
                        end
                        err = failure("CLEANUP_UNVERIFIED")
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
    function api.detach()
        epoch = epoch + 1
        operations.detach()
        local manager = local_manager()
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
        operations.stop(exact, report, { cwd = row and row.record.definition.cwd or snapshot.cwd })
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
            if manager.is_generating or not manager:can_submit_prompt() then callback({ state = "rejected", error = failure("NOT_READY") }); return false end
            local content = {}
            for _, item in ipairs(annotations) do content[#content + 1] = { type = "text", text = item.text } end
            local entry = Adapter.stage_context(manager, content, function()
                api.accept_annotations(annotations)
                callback({ state = "accepted", submissionId = manager._agency_local_submission })
            end, function(error) callback({ state = "rejected", error = error }) end)
            if not manager:_handle_input_submit(text) then
                Adapter.unstage_context(manager, entry)
                callback({ state = "rejected", error = failure("NOT_READY") })
                return false
            end
            return true
        end
        local manager = local_manager()
        if manager and manager.session_id then return send(nil, manager) end
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
    controller = api
    local commands = { Agency = { "roster", 0 }, AgencyCurrent = { "current", 0 }, AgencyNew = { "new", 0 },
        AgencyOpen = { "open", 0 }, AgencyAttach = { "attach", 1 }, AgencyRestore = { "restore", 1 },
        AgencySettings = { "settings", 0 }, AgencyDetach = { "detach", 0 }, AgencyCancel = { "cancel", 0 }, AgencyStop = { "stop", 0 }, AgencyInspect = { "inspect_delivery", 0 } }
    for name, spec in pairs(commands) do
        vim.api.nvim_create_user_command(name, function(args)
            if spec[2] == 1 then api[spec[1]](args.args) else api[spec[1]]() end
        end, { nargs = spec[2], force = true, complete = spec[2] == 1 and function(prefix)
            local ids = {}
            for _, row in ipairs(inventory) do
                local id = row.record.version == 3 and row.record.definition.agentId
                if id and id:sub(1, #prefix) == prefix then ids[#ids + 1] = id end
            end
            return ids
        end or nil })
    end
    return api
end

for _, name in ipairs({ "current", "new", "settings", "open", "attach", "restore", "detach", "cancel", "stop", "roster",
    "add_context", "add_diagnostics", "submit_text" }) do M[name] = function(...) return M.setup()[name](...) end end
function M.view_for_buffer(buf) return controller and controller.view_for_buffer(buf) end
return M