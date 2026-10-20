AgencyFixture = {}
local uv, original_spawn = vim.uv, vim.uv.spawn
local config = vim.json.decode(assert(vim.env.AGENCY_FIXTURE_CONNECTION))
vim.env.AGENCY_FIXTURE_CONNECTION = nil
local socket = assert(uv.new_pipe(false))
local launches, handles, stops, failures, pending, outgoing = {}, {}, {}, {}, {}, {}
local commands = {}
local last_handle
local sequence, connected, completed, frozen, buffer = 0, false, false, false, ""
local null = vim.NIL
local function fail(reason) failures[#failures + 1] = tostring(reason) end
local function transmit(frame, stop)
    sequence = sequence + 1
    frame.seq = sequence
    pending[sequence] = stop or true
    local text = vim.json.encode(frame) .. "\n"
    if #text > 65536 then fail("Oversized fixture frame"); return end
    if connected then socket:write(text, function(err) if err then fail(err) end end)
    else outgoing[#outgoing + 1] = text end
end
local function refresh()
    for id, handle in pairs(handles) do
        local value = launches[id]
        if value.reporting == "editor-endpoint" and value.exit == null and handle:is_closing() then value.unavailable = "editor-handle-closed" end
    end
end
local function snapshot(phase)
    refresh()
    local reports = {}
    for _, value in pairs(launches) do reports[#reports + 1] = { launch = value, ownGroup = value.reporting == "editor-endpoint", pipesClosed = true } end
    table.sort(reports, function(a, b) return a.launch.ref.launchId < b.launch.ref.launchId end)
    transmit({ type = "snapshot", phase = phase or "progress", snapshot = { failures = failures, children = {}, launches = reports } })
end
local scheduled = false
local function report()
    if scheduled or completed then return end
    scheduled = true
    vim.schedule(function() scheduled = false; if not completed then snapshot() end end)
end
local function launch(role, reporting)
    assert(not frozen, "Fixture launch admission closed")
    local id = config.ownerRef.launchId .. ":" .. tostring(uv.hrtime())
    local value = { ref = { runId = config.runId, launchId = id }, role = role, ownerId = config.ownerRef.launchId, pid = null, identity = null, error = null, exit = null, close = null, absent = null, reporting = reporting, unavailable = null }
    launches[id] = value
    return value
end
local stop_scheduled = 0
local function stop(value, signal)
    assert(signal == "SIGTERM" or signal == "SIGKILL", "Unsupported fixture signal")
    for _, item in ipairs(stops) do
        if item.ref.launchId == value.ref.launchId and item.outcome == "queued" then
            item.requested[#item.requested + 1] = signal
            if signal == "SIGKILL" then item.signal = signal end
            return true
        end
    end
    local item = { ref = value.ref, signal = signal, requested = { signal }, outcome = "queued" }
    stops[#stops + 1] = item
    stop_scheduled = stop_scheduled + 1
    vim.schedule(function()
        snapshot()
        transmit({ type = "editor-stop", ref = value.ref, signal = item.signal }, item)
        stop_scheduled = stop_scheduled - 1
    end)
    return true
end
transmit({ type = "hello", connection = config, pid = vim.fn.getpid() })
socket:connect(config.socketPath, function(err)
    if err then fail(err); socket:close(); return end
    connected = true
    socket:read_start(function(read_err, bytes)
        if read_err then fail(read_err) end
        if not bytes then if not completed then fail("Fixture receiver closed") end; pending = {}; return end
        buffer = buffer .. bytes
        if #buffer > 65536 then fail("Oversized fixture acknowledgement"); return end
        while true do
            local index = buffer:find("\n", 1, true)
            if not index then break end
            local ok, frame = pcall(vim.json.decode, buffer:sub(1, index - 1))
            buffer = buffer:sub(index + 1)
            if not ok or frame.type ~= "ack" or not pending[frame.seq] then fail("Invalid fixture acknowledgement")
            else
                local item = pending[frame.seq]
                pending[frame.seq] = nil
                if frame.accepted ~= true then fail(frame.error or "Fixture report refused") end
                if type(item) == "table" then item.outcome = frame.outcome or "refused-identity" end
            end
        end
    end)
    for _, text in ipairs(outgoing) do socket:write(text, function(write_err) if write_err then fail(write_err) end end) end
    outgoing = {}
end)
local local_uv = setmetatable({}, { __index = uv })
local_uv.spawn = function(command, opts, callback)
    local value = launch("acp-endpoint", "editor-endpoint")
    local ok, handle, pid = pcall(original_spawn, command, opts, function(code, signal)
        value.exit = { code = signal == 0 and code or null, signal = signal == 0 and null or (signal == 9 and "SIGKILL" or "SIGTERM") }
        report()
        local succeeded, reason = pcall(callback, code, signal)
        if not succeeded then value.error = tostring(reason); report(); error(reason) end
    end)
    if not ok then value.error = tostring(handle); report(); error(handle) end
    if handle then value.pid = pid; handles[value.ref.launchId] = handle; last_handle = handle
    else value.error = tostring(pid) end
    report()
    return handle, pid
end
local_uv.kill = function(pid, signal)
    for _, value in pairs(launches) do
        if value.reporting == "editor-endpoint" and value.pid == -pid then return stop(value, signal == 9 and "SIGKILL" or "SIGTERM") end
    end
    fail("Unregistered editor kill")
    return nil, "Unregistered editor kill"
end
local local_vim = setmetatable({ uv = local_uv, loop = local_uv }, { __index = vim })
local source = assert(loadfile(assert(vim.env.AGENCY_FIXTURE_PLUGIN_ROOT) .. "/lua/agentic/acp/acp_transport.lua"))
setfenv(source, setmetatable({ vim = local_vim }, { __index = _G }))
local transport_module = source()
assert(type(transport_module.create_stdio_transport) == "function", "Incompatible installed transport")
package.loaded["agentic.acp.acp_transport"] = transport_module
function AgencyFixture.global_spawn_unchanged() return vim.uv.spawn == original_spawn end
function AgencyFixture.registry()
    refresh()
    local result = {}
    for _, value in pairs(launches) do result[#result + 1] = value end
    return { launches = result, commands = commands, stops = stops, failures = failures, pending = vim.tbl_count(pending) }
end
function AgencyFixture.system(args, opts, callback)
    local value = launch("acp-control", "editor-control")
    local output = { ref = value.ref, code = null, signal = null, stdout = "", stderr = "" }
    commands[#commands + 1] = output
    local settings = vim.tbl_extend("force", {}, opts)
    for _, name in ipairs({ "stdout", "stderr" }) do
        if type(opts[name]) == "function" then
            settings[name] = function(err, bytes)
                if bytes then output[name] = output[name] .. bytes end
                return opts[name](err, bytes)
            end
        end
    end
    local ok, object = pcall(vim.system, args, settings, function(result)
        output.code, output.signal = result.code, result.signal
        output.stdout, output.stderr = result.stdout or output.stdout, result.stderr or output.stderr
        value.exit = { code = result.signal == 0 and result.code or null, signal = result.signal == 0 and null or (result.signal == 9 and "SIGKILL" or "SIGTERM") }
        value.unavailable = "editor-api-completion"
        report()
        local succeeded, reason = pcall(callback, result)
        if not succeeded then value.error = tostring(reason); report(); error(reason) end
    end)
    if not ok then value.error = tostring(object); report(); error(object) end
    value.pid = object.pid
    report()
    AgencyFixture.system_objects = AgencyFixture.system_objects or {}
    AgencyFixture.system_objects[value.ref.launchId] = object
    return { kill = function(_, signal) return stop(value, signal == 9 and "SIGKILL" or "SIGTERM") end }
end
function AgencyFixture.close_all()
    if fixture_control then fixture_control.close() end
    for _, instance in pairs(require("agentic.acp.agent_instance")._instances) do if instance.transport then instance.transport:stop() end end
    return true
end
function AgencyFixture.flush()
    assert(vim.wait(15000, function() return not scheduled and stop_scheduled == 0 and next(pending) == nil end, 10), "Fixture reporting deadline")
    assert(#failures == 0, table.concat(failures, "; "))
    return true
end
function AgencyFixture.complete()
    if completed then return true end
    frozen = true
    for _, value in pairs(launches) do if value.reporting == "editor-control" then assert(value.exit ~= null or value.pid == null and value.error ~= null, "Outstanding editor control command") end end
    AgencyFixture.flush()
    snapshot("complete")
    AgencyFixture.flush()
    completed = true
    socket:shutdown(function() socket:close() end)
    return true
end
function AgencyFixture.adapter_probe(mode)
    if mode == "failure" then
        local handle = local_uv.spawn("/missing-agency-fixture", { args = {}, detached = true }, function() end)
        assert(handle == nil)
    else
        local transport = transport_module.create_stdio_transport({ command = assert(vim.env.AGENCY_FIXTURE_NODE), args = { "-e", mode == "early" and "process.exit(0)" or "setInterval(()=>{},1000)" } }, { on_state_change = function() end, on_message = function() end })
        transport:start()
        local handle = transport.process
        assert(handle == last_handle)
        if mode == "stop" then transport:stop(); assert(handle:is_closing())
        else assert(vim.wait(5000, function() return transport.process == nil end, 10)) end
    end
    AgencyFixture.flush()
    return true
end
vim.api.nvim_create_autocmd("VimLeavePre", { callback = function() AgencyFixture.close_all(); AgencyFixture.complete() end })
function AgencyFixture.commands()
    local control = require("sodium.agency.control").new({ system = function(argv, opts, callback)
        local args = { assert(vim.env.AGENCY_FIXTURE_NODE), assert(vim.env.AGENCY_FIXTURE_CONTROL), assert(vim.env.AGENCY_FIXTURE_CONFIG) }
        vim.list_extend(args, vim.list_slice(argv, 2))
        return AgencyFixture.system(args, opts, callback)
    end })
    _G.fixture_control = control
    _G.fixture_notifications = {}
    _G.fixture_controller = require("sodium.agency").setup({ client = control, roster_request = require("sodium.agency.roster").new(),
        notify = function(value) fixture_notifications[#fixture_notifications + 1] = value end })
    return true
end
function AgencyFixture.new(opts)
    _G.fixture_manager = require("sodium.agency.agentic").new_session(opts)
    return true
end
function AgencyFixture.open(view)
    _G.fixture_manager = require("sodium.agency.agentic").open(view)
    return true
end
function AgencyFixture.close_tab()
    local registry = require("agentic.session_registry")
    registry.destroy_session()
    if #vim.api.nvim_list_tabpages() > 1 then vim.cmd("tabclose") end
    return true
end