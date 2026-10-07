local M = {}
local Control = require("sodium.agency.control")

local function failure(code, message)
    return { code = code, message = message or code:lower():gsub("_", " ") }
end

function M.new(deps)
    deps = deps or {}
    return function(options, callback)
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
        timer:start(deps.timeout_ms or 5000, 0, vim.schedule_wrap(function() finish(failure("UNAVAILABLE")) end))
        local ok = pcall(function()
            client = require("agentic.acp.agent_instance").get_instance("agency", function() end)
            if client.state == "disconnected" or client.state == "error" then finish(failure("UNAVAILABLE")); return end
            ready = function()
                if settled then return end
                if client.state ~= "ready" then finish(failure("UNAVAILABLE")); return end
                response = vim.schedule_wrap(function(result, err)
                    if settled then return end
                    if err then
                        local agency = type(err.data) == "table" and err.data.agency
                        local code = type(agency) == "table" and type(agency.code) == "string" and agency.code or "UNAVAILABLE"
                        finish(failure(code, err.code == -32601 and "Agency roster unavailable; restart the Handler to load the updated endpoint" or err.message))
                        return
                    end
                    local valid, envelope = pcall(Control.page_envelope, result)
                    if not valid then finish(failure("INVALID_PROTOCOL")) else finish(nil, envelope) end
                end)
                request_id = client.id_counter + 1
                local sent = pcall(client._send_request, client, "agency/roster", options, response)
                if not sent then finish(failure("UNAVAILABLE")) end
            end
            client:when_ready(ready)
        end)
        if not ok then finish(failure("UNAVAILABLE")) end
        return function()
            if not settled then settled = true; cleanup() end
        end
    end
end

return M