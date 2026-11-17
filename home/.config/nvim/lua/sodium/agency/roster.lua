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
}

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

function M.new(deps)
    return function(options, callback) return M.request("agency/roster", options, callback, deps) end
end

return M