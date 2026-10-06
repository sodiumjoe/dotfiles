local M = {}
function M.new()
    local Config, Instances = require("agentic.config"), require("agentic.acp.agent_instance")
    local Registry, ACPClient = require("agentic.session_registry"), require("agentic.acp.acp_client")
    local saved = { Config.provider, Config.acp_providers.agency, Instances._instances }
    Config.provider = "agency"
    Config.acp_providers.agency = { name = "Agency", command = vim.v.progpath, args = {} }
    local frames = {}
    local client = setmetatable({ provider_config = Config.acp_providers.agency, state = "ready", callbacks = {},
        subscribers = {}, id_counter = 0, ready_listeners = {}, agent_capabilities = { loadSession = true },
        transport = { send = function(_, data) frames[#frames + 1] = vim.json.decode(data) end } }, ACPClient)
    Instances._instances = { agency = client }
    local adapter = require("sodium.agency.agentic")
    adapter.install()
    local control = require("fixtures.agency_control")
    local row = control.agent(control.target_a)
    row.record.definition.cwd = vim.fn.getcwd()
    local manager = adapter.open(row)
    local function flush() vim.wait(30, function() return false end) end
    local function request(method)
        for i = #frames, 1, -1 do if frames[i].method == method then return frames[i] end end
        error("missing " .. method)
    end
    flush()
    local frame = request("session/load")
    client:_handle_message({ id = frame.id, result = { sessionId = "agency:" .. control.target_a.agentId,
        _meta = { agency = { version = 1, binding = control.target_a, backendId = "codex-acp",
            configuration = { configOptions = {}, availableCommands = {} } } } } })
    flush()
    manager.code_selection:clear()
    manager.file_list:clear()
    manager.diagnostics_list:clear()
    manager._is_first_message = false
    return { manager = manager, client = client, frames = frames, row = row, request = request, flush = flush,
        state = function(turn, state)
            client:_handle_message({ method = "agency/session_state", params = { sessionId = manager.session_id,
                binding = control.target_a, turnId = turn, state = state } }); flush()
        end,
        close = function()
            for tab in pairs(Registry.sessions) do Registry.destroy_session(tab) end
            flush()
            Config.provider, Config.acp_providers.agency, Instances._instances = unpack(saved)
            while #vim.api.nvim_list_tabpages() > 1 do vim.cmd("tabclose!") end
            package.loaded["sodium.agency"] = nil
        end }
end
return M