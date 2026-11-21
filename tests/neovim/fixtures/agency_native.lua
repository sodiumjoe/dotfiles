local M = {}
function M.new()
    local Config, Instances = require("agentic.config"), require("agentic.acp.agent_instance")
    local Registry, Client = require("agentic.session_registry"), require("sodium.agency.client")
    local saved = { Config.provider, Config.acp_providers.agency, Instances._instances, Config.hooks }
    Config.hooks = vim.tbl_extend("force", Config.hooks or {}, { on_response_complete = function() end })
    Config.provider = "agency"
    Config.acp_providers.agency = { name = "Agency", command = vim.v.progpath, args = {}, client_class = Client.class, render_live_user_messages = true }
    local frames = {}
    local client = setmetatable({ provider_config = Config.acp_providers.agency, state = "ready", callbacks = {},
        subscribers = {}, id_counter = 0, ready_listeners = {}, agent_capabilities = { loadSession = true },
        transport = { send = function(_, data) frames[#frames + 1] = vim.json.decode(data) end } }, Client.class)
    Instances._instances = { agency = client }
    local control = require("fixtures.agency_control")
    local row = control.agent(control.target_a)
    row.record.definition.cwd = vim.fn.getcwd()
    vim.api.nvim_win_set_buf(0, vim.api.nvim_create_buf(true, true))
    local key = require("sodium.agency").open(row).session_key
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
    local manager = Registry.get(key)
    manager.code_selection:clear()
    manager.file_list:clear()
    manager.diagnostics_list:clear()
    return { manager = manager, client = client, frames = frames, row = row, request = request, flush = flush,
        state = function(turn, state)
            client:_handle_message({ method = "agency/session_state", params = { sessionId = manager.session_id,
                binding = control.target_a, turnId = turn, state = state } }); flush()
        end,
        close = function()
            for _, session in ipairs(vim.tbl_keys(Registry.sessions)) do Registry.destroy(session) end
            flush()
            Config.provider, Config.acp_providers.agency, Instances._instances, Config.hooks = unpack(saved, 1, 4)
            while #vim.api.nvim_list_tabpages() > 1 do vim.cmd("tabclose!") end
            vim.cmd("silent! only!")
            vim.api.nvim_win_set_buf(0, vim.api.nvim_create_buf(true, false))
            vim.wo.winfixheight = false
            package.loaded["sodium.agency"] = nil
            package.loaded["sodium.agency.screen"] = nil
        end }
end
return M