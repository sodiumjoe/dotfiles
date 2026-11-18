local M = {}
local Control = require("sodium.agency.control")

local function failure(code, message)
    return { code = code, message = message or code:lower():gsub("_", " ") }
end

function M.validate(result)
    assert(type(result) == "table" and result.state == "agents" and type(result.agents) == "table" and vim.islist(result.agents))
    for _, row in ipairs(result.agents) do Control.row(row) end
    return result
end

local validators = {
    ["agency/roster"] = M.validate,
    ["agency/excerpt"] = function(result) Control.excerpt(result); return result end,
    ["agency/stop"] = function(result)
        assert(type(result) == "table" and result.state == "agent")
        Control.row(result.agent)
        return result
    end,
}
validators["agency/remotes"] = function(result)
    assert(type(result) == "table" and type(result.hosts) == "table" and vim.islist(result.hosts))
    for _, host in ipairs(result.hosts) do
        assert(type(host.hostId) == "string" and host.hostId:match("^%x+$") and #host.hostId == 64 and type(host.hostname) == "string")
        assert(vim.tbl_contains({ "connecting", "online", "offline", "outdated" }, host.state))
        assert(host.since == nil or host.since == vim.NIL or type(host.since) == "number")
        assert(host.name == nil or host.name == vim.NIL or type(host.name) == "string")
        assert(type(host.agents) == "table" and vim.islist(host.agents))
        for _, row in ipairs(host.agents) do Control.row(row) end
    end
    return result
end
local function host_id(value) return type(value) == "string" and #value == 64 and value:match("^%x+$") ~= nil end
validators["agency/approvals"] = function(result)
    assert(type(result) == "table" and result.state == "permissions" and type(result.hosts) == "table" and type(result.pending) == "table")
    for _, host in ipairs(result.hosts) do
        assert(host_id(host.hostId))
        if host.state == "available" then assert(type(host.value) == "table" and host.value.hostId == host.hostId)
        else assert(host.state == "unavailable" and type(host.code) == "string") end
    end
    for _, offer in ipairs(result.pending) do assert(type(offer.ref) == "table" and host_id(offer.ref.hostId)) end
    return result
end
validators["agency/decide"] = function(result)
    assert(type(result) == "table" and result.state == "permission" and type(result.receipt) == "table")
    assert(vim.tbl_contains({ "claimed", "applied", "withdrawn", "stale", "uncertain" }, result.receipt.state))
    return result
end
validators["agency/entry"] = function(result)
    assert(type(result) == "table" and result.state == "entry" and type(result.receipt) == "table" and type(result.enrollment) == "table")
    local receipt = result.receipt
    assert(vim.tbl_contains({ "opening", "opened", "uncertain", "stale" }, receipt.state) and type(receipt.ref) == "table")
    if receipt.state == "opened" then
        local editor = receipt.editor
        assert(type(editor) == "table" and type(editor.session) == "string" and editor.session:match("^[%w_-]+$")
            and type(editor.pane) == "string" and editor.pane:match("^%%[0-9]+$") and type(editor.tmuxSocketPath) == "string")
    end
    assert(host_id(result.enrollment.hostId) and type(result.enrollment.hostname) == "string")
    return result
end
M.validators = validators

local codes = { connecting = "CONNECTING", offline = "OFFLINE", outdated = "UPDATE_REQUIRED" }

function M.hosts(result)
    local hosts = {}
    for _, host in ipairs(result.hosts) do
        if host.state == "online" then
            local views = {}
            for _, row in ipairs(host.agents) do
                local view = Control.view(row)
                view.record.definition.hostId = host.hostId
                views[#views + 1] = view
            end
            hosts[#hosts + 1] = { hostId = host.hostId, hostname = host.hostname, name = type(host.name) == "string" and host.name or nil, state = "available",
                value = { handlerGeneration = host.handlerGeneration, agents = views, issues = {} } }
        else
            hosts[#hosts + 1] = { hostId = host.hostId, hostname = host.hostname, name = type(host.name) == "string" and host.name or nil, state = "unavailable", code = codes[host.state], error = host.state == "offline" and type(host.error) == "string" and host.error or nil,
                since = type(host.since) == "number" and host.since or nil }
        end
    end
    return { state = "roster", localHostId = vim.NIL, hosts = hosts }
end

function M.request(method, params, callback, opts)
    opts = opts or {}
    local settled, client, request_id, ready, response = false, nil, nil, nil, nil
    local timer = assert(vim.uv.new_timer())
    local function cleanup()
        timer:stop(); timer:close()
        if not client then return end
        for index, listener in ipairs(client.ready_listeners) do
            if listener == ready then table.remove(client.ready_listeners, index); break end
        end
        if request_id and client.callbacks[request_id] == response then client.callbacks[request_id] = nil end
    end
    local function finish(err, envelope)
        if settled then return end
        settled = true
        cleanup()
        vim.schedule(function() callback(err, envelope) end)
    end
    timer:start(opts.timeout_ms or 5000, 0, vim.schedule_wrap(function() finish(failure("UNAVAILABLE")) end))
    local ok = pcall(function()
        client = require("agentic.acp.agent_instance").get_instance("agency")
        if client.state == "disconnected" or client.state == "error" then finish(failure("UNAVAILABLE")); return end
        ready = function()
            if settled then return end
            if client.state ~= "ready" then finish(failure("UNAVAILABLE")); return end
            response = vim.schedule_wrap(function(result, err)
                if settled then return end
                if err then
                    local agency = type(err.data) == "table" and err.data.agency
                    local code = type(agency) == "table" and type(agency.code) == "string" and agency.code or "UNAVAILABLE"
                    finish(failure(code, err.code == -32601 and "the running Agency Handler does not serve " .. method .. "; run :AgencyReload to update it" or err.message))
                    return
                end
                local valid, envelope = pcall(function() return { result = validators[method](result) } end)
                if not valid then finish(failure("INVALID_PROTOCOL")) else finish(nil, envelope) end
            end)
            request_id = client.id_counter + 1
            local sent = pcall(client._send_request, client, method, params, response)
            if not sent then finish(failure("UNAVAILABLE")) end
        end
        client:when_ready(ready)
    end)
    if not ok then finish(failure("UNAVAILABLE")) end
    return function()
        if not settled then settled = true; cleanup() end
    end
end

return M