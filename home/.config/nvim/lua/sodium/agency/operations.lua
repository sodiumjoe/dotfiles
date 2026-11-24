local M = {}
local null = vim.NIL
local Control = require("sodium.agency.control")
local error_value, tuple_of = Control.failure, Control.target

function M.new(deps)
    deps = deps or {}
    local request = deps.request or require("sodium.agency.roster").request
    local select_agent = deps.select_agent
        or function(agents, callback)
            return require("sodium.agency.picker").current(agents, callback)
        end
    local confirm_stop = deps.confirm_stop
        or function(target, callback)
            local detail = target.detail or {}
            vim.ui.select(
                { "Stop", "Keep running" },
                {
                    prompt = table.concat(
                        {
                            "Stop Agency agent",
                            target.agentId,
                            target.handlerGeneration,
                            target.providerGeneration,
                            detail.model or "",
                            detail.cwd or "",
                        },
                        "\n"
                    ),
                },
                function(value)
                    callback(value == "Stop")
                end
            )
        end
    local epoch, pending, sequence, api = 0, {}, 0, {}
    local current_origin
    local function begin(cwd, origin)
        epoch = epoch + 1
        current_origin = {
            buffer = vim.api.nvim_get_current_buf(),
            cwd = cwd or vim.fn.getcwd(),
        }
        if origin then
            current_origin = vim.deepcopy(origin)
        end
        return epoch
    end
    local function valid_operation(operation)
        return operation == epoch
    end
    local inventory
    local function attach(target, callback, operation)
        inventory({}, function(err, result)
            if not valid_operation(operation) then callback(error_value("CANCELLED")); return end
            if err then callback(err); return end
            for _, row in ipairs(result.agents) do
                if row.record.definition.agentId == target.agentId then
                    if not row.live or row.record.phase ~= "ready" or not tuple_of(row) then callback(error_value("NOT_READY")); return end
                    if not vim.deep_equal(tuple_of(row), target) then callback(error_value("STALE_PROVIDER")); return end
                    local manager = deps.open(row)
                    if not manager then callback({ code = "FAILED", message = "the session could not be opened" }); return end
                    manager:on_session_ready(function()
                        if not valid_operation(operation) then callback(error_value("CANCELLED")); return end
                        callback(nil, manager)
                    end)
                    return
                end
            end
            callback(error_value("UNAVAILABLE"))
        end, operation)
    end
    inventory = function(options, callback, operation)
        options = options or {}
        request("agency/roster", options.cwd and { cwd = options.cwd } or vim.empty_dict(), function(error, envelope)
            if operation and not valid_operation(operation) or options.alive and not options.alive() then
                callback(error_value("CANCELLED"))
                return
            end
            if error then callback(error); return end
            local result = envelope.result
            local generation = result.handlerGeneration ~= null and result.handlerGeneration or nil
            local agents = {}
            for _, row in ipairs(result.agents) do
                local live = row.live ~= nil and row.live ~= null
                if (not options.cwd or row.cwd == options.cwd) and (not options.active or live) then agents[#agents + 1] = Control.view(row) end
            end
            table.sort(agents, function(a, b) return a.record.definition.agentId < b.record.definition.agentId end)
            callback(nil, { agents = agents, handlerGeneration = generation, issues = {} })
        end, { timeout_ms = 10000 })
    end
    function api.page(options, callback)
        inventory(options, callback)
    end
    function api.current(cwd, callback, captured, focus)
        cwd = cwd or vim.fn.getcwd()
        local operation = begin(cwd, captured)
        local origin = vim.deepcopy(current_origin)
        inventory({ cwd = cwd, active = true }, function(error, result)
            if not valid_operation(operation) then
                callback(error_value("CANCELLED"))
                return
            end
            if error then
                callback(error, result)
                return
            end
            if #result.agents == 0 then
                deps.new_session({ cwd = origin.cwd, focus = focus }, callback)
                return
            end
            local function selected(view)
                if not valid_operation(operation) then
                    callback(error_value("CANCELLED"))
                    return
                end
                if not view then
                    callback(error_value("CANCELLED"))
                    return
                end
                if not view.live or view.record.phase ~= "ready" then
                    callback(error_value("NOT_READY"), view)
                    return
                end
                local manager = deps.open(view, focus)
                if not manager then callback({ code = "FAILED", message = "the session could not be opened" }); return end
                manager:on_session_ready(function()
                    if valid_operation(operation) then callback(nil, manager) else callback(error_value("CANCELLED")) end
                end)
            end
            if #result.agents == 1 then
                selected(result.agents[1])
            else
                select_agent(result.agents, selected)
            end
        end, operation)
    end
    function api.attach(target, callback, origin)
        local operation = begin(nil, origin)
        attach(vim.deepcopy(target), callback, operation)
    end
    function api.stop(target, callback, detail)
        local operation, cwd, exact = begin(), vim.fn.getcwd(), vim.deepcopy(target)
        local display = vim.deepcopy(exact)
        if detail then
            display.detail = vim.deepcopy(detail)
        end
        confirm_stop(display, function(confirmed)
            if not valid_operation(operation) then
                callback(error_value("CANCELLED"))
                return
            end
            if not confirmed then
                callback(error_value("CANCELLED"))
                return
            end
            sequence = sequence + 1
            local key = sequence
            pending[key] = { op = "stop", agentId = exact.agentId, cwd = cwd, startedAt = os.date("!%Y-%m-%dT%H:%M:%SZ") }
            request("agency/stop", { agentId = exact.agentId }, function(error, envelope)
                pending[key] = nil
                if error then callback(error, envelope); return end
                callback(nil, envelope.result)
            end, { timeout_ms = 310000 })
        end)
    end
    function api.inspect_pending(callback)
        local requests = {}
        for _, value in pairs(pending) do
            requests[#requests + 1] = vim.deepcopy(value)
        end
        table.sort(requests, function(a, b)
            return a.startedAt < b.startedAt
        end)
        callback(nil, requests)
    end
    function api.detach()
        begin()
    end
    function api.in_flight()
        return vim.tbl_count(pending)
    end
    return api
end

return M