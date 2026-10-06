AgencyFixture = {}
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