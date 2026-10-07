AgencyFixture = {}
function AgencyFixture.commands()
    local control = require("sodium.agency.control").new({ system = function(argv, opts, callback)
        local args = { assert(vim.env.AGENCY_FIXTURE_NODE), assert(vim.env.AGENCY_FIXTURE_CONTROL), assert(vim.env.AGENCY_FIXTURE_CONFIG) }
        vim.list_extend(args, vim.list_slice(argv, 2))
        return vim.system(args, opts, callback)
    end })
    _G.fixture_notifications = {}
    _G.fixture_controller = require("sodium.agency").setup({ client = control,
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