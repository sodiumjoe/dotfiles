local ACPClient = require("agentic.acp.acp_client")
local Client = setmetatable({}, { __index = ACPClient })
Client.__index = Client

function Client:new(config, on_ready)
    return ACPClient.new(self, config, on_ready)
end

function Client:request(method, params, callback)
    return self:_send_request(method, params, callback)
end

function Client:request_with_timeout(method, params, timeout_ms, callback)
    local settled, timer, ready, response = false, assert(vim.uv.new_timer()), nil, nil
    local function cleanup()
        timer:stop()
        timer:close()
        for index, listener in ipairs(self.ready_listeners) do
            if listener.on_ready == ready then
                table.remove(self.ready_listeners, index)
                break
            end
        end
        for id, pending in pairs(self.callbacks) do
            if pending == response then
                self.callbacks[id] = nil
                break
            end
        end
    end
    local function finish(result, err)
        if settled then
            return
        end
        settled = true
        cleanup()
        vim.schedule(function()
            callback(result, err)
        end)
    end
    timer:start(timeout_ms, 0, function()
        finish(nil, self:__create_error(self.ERROR_CODES.TIMEOUT_ERROR, method .. " timed out"))
    end)
    ready = function()
        if settled then
            return
        end
        response = function(result, err)
            finish(result, err)
        end
        local sent, failure = pcall(self._send_request, self, method, params, response)
        if not sent then
            finish(nil, self:__create_error(self.ERROR_CODES.TRANSPORT_ERROR, tostring(failure)))
        end
    end
    self:when_ready(ready, function(err)
        finish(nil, err)
    end)
    return function()
        if not settled then
            settled = true
            cleanup()
        end
    end
end

return Client