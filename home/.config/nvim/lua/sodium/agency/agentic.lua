local M = {}

function M.guard_callback(manager, captured, callback)
    return function(...)
        if manager._agency_destroyed or manager._agency_epoch ~= captured.epoch
            or captured.check_binding and not vim.deep_equal(manager._agency_binding, captured.binding)
            or captured.check_turn and manager._agency_turn_id ~= captured.turn_id then return end
        return callback(...)
    end
end

function M.apply_configuration(options, snapshot)
    options:set_options(snapshot.configOptions or {})
    if type(snapshot.models) == "table" then options:set_legacy_models(snapshot.models) end
    if type(snapshot.modes) == "table" then options:set_legacy_modes(snapshot.modes) end
end

function M.stage_context(manager, content, accepted, rejected)
    manager._agency_pending_context = manager._agency_pending_context or {}
    local entry = { content = vim.deepcopy(content), accepted = accepted, rejected = rejected }
    table.insert(manager._agency_pending_context, entry)
    return entry
end

function M.unstage_context(manager, entry)
    for index, value in ipairs(manager._agency_pending_context or {}) do
        if value == entry then table.remove(manager._agency_pending_context, index); return end
    end
end

local function client() return require("agentic.acp.agent_instance").get_instance("agency") end

function M.open(view, opts)
    opts = opts or {}
    local record = assert(view.record)
    assert(record.version == 3, "Unavailable legacy Agency session")
    local id, Registry = "agency:" .. record.definition.agentId, require("agentic.session_registry")
    local agent = assert(client(), "Agency is not configured")
    local manager = Registry.find_by_acp_session_id(id, agent)
    if not manager then
        require("sodium.agency.layout").cleanup()
        manager = assert(Registry.create("agency", { kind = "load", session_id = id, cwd = record.definition.cwd, title = record.definition.backendId }, agent))
    end
    if not opts.quiet then Registry.show_session(manager.session_key) end
    return manager
end

function M.new_session(opts)
    opts = opts or {}
    local Registry = require("agentic.session_registry")
    local agent = assert(client(), "Agency is not configured")
    require("sodium.agency.layout").cleanup()
    local cwd = opts.cwd
    local meta = { backend_id = opts.backend_id, selection = opts.selection, environment = opts.environment }
    local manager = assert(Registry.create("agency", { kind = "new", cwd = cwd and function() return cwd end, meta = meta }, agent))
    Registry.show_session(manager.session_key)
    return manager
end

return M