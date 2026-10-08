local M = {}
local Control = require("sodium.agency.control")
local function quote(value)
    assert(type(value) == "string" and not value:find("%c"))
    return "'" .. value:gsub("'", "'\\''") .. "'"
end
local function control_path()
    local directory = vim.fn.expand("~/.ssh/devbox-control")
    vim.fn.mkdir(directory, "p", 448)
    local stat = vim.uv.fs_lstat(directory)
    assert(stat and stat.type == "directory" and bit.band(stat.mode, 63) == 0 and stat.uid == vim.uv.getuid())
    return directory .. "/%C"
end
local function launch(argv, notify)
    local prefix = vim.g.agency_remote_terminal_argv
    if prefix == nil and vim.env.TMUX then prefix = { "tmux", "new-window", "-n", "agency-remote" } end
    assert(type(prefix) == "table" and #prefix > 0, "Configure agency_remote_terminal_argv outside tmux")
    local args = vim.deepcopy(prefix)
    vim.list_extend(args, argv)
    vim.system(args, { detach = true, stderr = function() end }, function(result)
        if result.code ~= 0 then vim.schedule(function() notify("Remote entry terminal failed") end) end
    end)
end
function M.new(deps)
    deps = deps or {}
    local client, uuid = deps.client or Control, deps.uuid or Control.uuid
    local notify = deps.notify or function(value) vim.notify("Agency: " .. tostring(value)) end
    return { enter = function(ref)
        local command_id = uuid()
        client.command({ "entry", "prepare", "--input-json", vim.json.encode(ref), "--command-id", command_id }, { timeout_ms = 15000 }, function(err, response)
            if err then notify(err.message or err.code); return end
            local ok, argv = pcall(function()
                local intent, enrollment = response.result.intent, response.result.enrollment
                assert(intent.state == "prepared" and intent.commandId == command_id and vim.deep_equal(intent.ref, ref))
                assert(type(intent.digest) == "string" and #intent.digest == 64 and intent.digest:match("^%x+$"))
                assert(enrollment.hostId == ref.hostId and enrollment.inventoryId == ref.inventoryId)
                assert(enrollment.hostname:match("^[%w][%w._-]*$"))
                local helper = { enrollment.agyPath, "internal-entry", command_id, "--digest", intent.digest,
                    "--host-id", ref.hostId, "--inventory-id", ref.inventoryId, "--handler-generation", ref.target.handlerGeneration }
                local quoted = {}; for _, value in ipairs(helper) do quoted[#quoted + 1] = quote(value) end
                local destination = "exec " .. quote(enrollment.loginShell) .. " -lc " .. quote("exec " .. table.concat(quoted, " "))
                return { "ssh", "-t", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10",
                    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", "-o", "ControlMaster=auto", "-o", "ControlPersist=60",
                    "-o", "ControlPath=" .. (deps.control_path or control_path)(), "--", enrollment.hostname, destination }
            end)
            if not ok then notify("Remote entry rejected: " .. tostring(argv)); return end
            local started, failure = pcall(deps.launch or launch, argv, notify)
            if not started then notify("Remote entry failed: " .. tostring(failure)) end
        end)
    end }
end
function M.bind(value)
    local Registry = require("agentic.session_registry")
    local manager = Registry.sessions[vim.api.nvim_get_current_tabpage()]
    if manager and manager._agency_entry and vim.deep_equal(manager._agency_binding, value.target) then return true end
    if M.binding then return true end
    M.binding = true
    local expected = { record = { version = 3, definition = { agentId = value.target.agentId }, launch = value.target } }
    require("sodium.agency").setup().attach(value.target.agentId, function(err, attached)
        M.binding = nil
        if not err and attached and vim.deep_equal(attached._agency_binding, value.target) then
            attached._agency_entry = vim.deepcopy(value)
        end
    end, expected)
    return true
end
function M.status(value)
    local manager = require("agentic.session_registry").sessions[vim.api.nvim_get_current_tabpage()]
    if manager and manager._agency_entry and manager._agency_entry.editorId == value.editorId
        and vim.deep_equal(manager._agency_binding, value.target) then return vim.json.encode(manager._agency_entry) end
    return "null"
end
return M