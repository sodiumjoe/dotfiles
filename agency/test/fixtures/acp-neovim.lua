AgencyFixture = {}
function AgencyFixture.record(value)
    if not vim.env.AGENCY_TEST_EVIDENCE_ROOT then return end
    local fd = assert(vim.uv.fs_open(vim.env.AGENCY_TEST_EVIDENCE_ROOT .. "/ownership.jsonl", "a", 384))
    assert(vim.uv.fs_write(fd, vim.json.encode(value) .. "\n"))
    assert(vim.uv.fs_fsync(fd))
    assert(vim.uv.fs_close(fd))
end
local original_spawn = vim.uv.spawn
vim.uv.spawn = function(command, opts, callback)
    if command ~= vim.env.AGENCY_FIXTURE_NODE or not opts.args or opts.args[1] ~= vim.env.AGENCY_FIXTURE_ENDPOINT then
        return original_spawn(command, opts, callback)
    end
    local launch = { launchId = vim.fn.sha256(tostring(vim.uv.hrtime()) .. tostring(vim.fn.getpid())), role = "acp-endpoint" }
    AgencyFixture.record(vim.tbl_extend("force", launch, { type = "intent" }))
    local config = vim.json.decode(table.concat(vim.fn.readfile(vim.env.AGENCY_FIXTURE_CONFIG), "\n"))
    config.ownershipLaunch = launch
    vim.fn.writefile({ vim.json.encode(config) }, vim.env.AGENCY_FIXTURE_CONFIG)
    local handle, pid = original_spawn(command, opts, function(code, signal)
        AgencyFixture.record(vim.tbl_extend("force", launch, { type = "exit", exitCode = code, signal = signal }))
        callback(code, signal)
    end)
    AgencyFixture.record(vim.tbl_extend("force", launch, { type = "spawn", pid = handle and pid or vim.NIL }))
    if not handle then AgencyFixture.record(vim.tbl_extend("force", launch, { type = "no-process" })) end
    return handle, pid
end
function AgencyFixture.commands()
    local control = require("sodium.agency.control").new({ system = function(argv, opts, callback)
        local args = { assert(vim.env.AGENCY_FIXTURE_NODE), assert(vim.env.AGENCY_FIXTURE_CONTROL), assert(vim.env.AGENCY_FIXTURE_CONFIG) }
        vim.list_extend(args, vim.list_slice(argv, 2))
        return vim.system(args, opts, callback)
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