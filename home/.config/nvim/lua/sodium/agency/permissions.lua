local M = {}
local function key(ref)
    assert(type(ref) == "table" and type(ref.hostId) == "string" and #ref.hostId == 64 and ref.hostId:match("^[a-f0-9]+$"))
    local target = ref.target
    assert(type(target) == "table" and type(ref.revision) == "number" and ref.revision > 0 and ref.revision % 1 == 0)
    local values = { ref.hostId, target.agentId, target.handlerGeneration, target.providerGeneration, ref.permissionId, tostring(ref.revision) }
    for _, value in ipairs(values) do assert(type(value) == "string" and value ~= "") end
    assert(#values == 6)
    return table.concat(values, ":")
end
function M.new(deps)
    deps = deps or {}
    local command = deps.command or require("sodium.agency.control").command
    local select = deps.select or function(items, options, callback)
        if not Snacks or not Snacks.picker then
            options.prompt = options.prompt .. "\n" .. (options.preview and options.preview(items[1]) or "")
            return vim.ui.select(items, options, callback)
        end
        local rows = {}
        for _, value in ipairs(items) do rows[#rows + 1] = { text = options.format_item(value), value = value,
            preview = vim.split(options.preview(value), "\n", { plain = true }) } end
        return Snacks.picker({ title = options.prompt, items = rows, format = "text", layout = { preset = "default" },
            preview = function(ctx) ctx.preview:reset(); if ctx.item then ctx.preview:set_lines(ctx.item.preview) end end,
            confirm = function(picker, item) picker:close(); vim.schedule(function() callback(item and item.value) end) end })
    end
    local uuid = deps.uuid or require("sodium.agency.control").uuid
    local notify = deps.notify or function(message) vim.notify("Agency: " .. message) end
    local api, requests, closed, available, epoch, stream, unavailable = {}, {}, false, false, 0, nil, {}
    function api.update(snapshot)
        if closed then return end
        local next = {}
        for _, offer in ipairs(snapshot.pending or {}) do
            local identity = key(offer.ref)
            assert(not next[identity] and type(offer.options) == "table" and #offer.options > 0)
            next[identity] = vim.deepcopy(offer)
        end
        requests, available, unavailable = next, true, snapshot.unavailable or {}
    end
    function api.unavailable()
        if closed then return end
        available, epoch, requests = false, epoch + 1, {}
    end
    function api.subscribe()
        if closed or stream then return end
        stream = (deps.watch or require("sodium.agency.watch").new)()
        stream.start({ "permission", "watch" }, function(snapshot)
            local ok = pcall(api.update, snapshot)
            if not ok then api.unavailable() end
        end, api.unavailable)
    end
    function api.pending()
        local values = {}
        for _, offer in pairs(requests) do values[#values + 1] = vim.deepcopy(offer) end
        table.sort(values, function(a, b) return key(a.ref) < key(b.ref) end)
        return values
    end
    function api.preview(offer)
        return table.concat({ "Host: " .. offer.ref.hostId, "Agent: " .. offer.ref.target.agentId,
            "Handler: " .. offer.ref.target.handlerGeneration, "Provider: " .. offer.ref.target.providerGeneration,
            "Origin directory: " .. offer.originCwd, "Request: " .. offer.ref.permissionId .. "/" .. offer.ref.revision,
            "Subject: " .. vim.json.encode(offer.subject), "Options: " .. vim.json.encode(offer.options) }, "\n")
    end
    function api.refresh(callback)
        if closed then return end
        command({ "permission", "list" }, { timeout_ms = 10000 }, function(err, envelope)
            if closed then return end
            if err then api.unavailable(); if callback then callback(err) end; return end
            api.update(envelope.result)
            if callback then callback(nil, api.pending()) end
        end)
    end
    function api.choose(ref)
        if closed or not available then return end
        local identity, offer, token = key(ref), requests[key(ref)], epoch
        if not offer then return end
        select(vim.deepcopy(offer.options), { prompt = offer.title .. " · " .. ref.hostId:sub(1, 12) .. ":" .. offer.originCwd,
            format_item = function(option) return option.name end, preview = function() return api.preview(offer) end }, function(option)
            if closed or token ~= epoch or not available or not option or not requests[identity] or not vim.deep_equal(requests[identity], offer) then return end
            local advertised = false
            for _, value in ipairs(offer.options) do if vim.deep_equal(value, option) then advertised = true end end
            if not advertised then return end
            available = false
            command({ "permission", "decide", "--command-id", uuid(), "--input-json", vim.json.encode({ ref = offer.ref, optionId = option.optionId }) },
                { timeout_ms = 15000 }, function(err, envelope)
                    if closed then return end
                    if err then notify(err.message or err.code); return end
                    local state = envelope.result.state
                    requests[identity] = nil
                    notify("Approval " .. state .. " on " .. offer.ref.hostId:sub(1, 12))
                    api.refresh()
                end)
        end)
    end
    function api.open()
        api.refresh(function(err, pending)
            if err then notify(err.message or err.code); return end
            if #pending == 0 then notify(#unavailable > 0 and "Approval origins unavailable: " .. #unavailable or "No routed approvals pending"); return end
            select(pending, { prompt = "Agency routed approvals", format_item = function(offer)
                return offer.title .. " · " .. offer.ref.hostId:sub(1, 12) .. ":" .. offer.originCwd
            end, preview = api.preview }, function(offer) if offer then api.choose(offer.ref) end end)
        end)
    end
    function api.close() closed, available, requests, epoch = true, false, {}, epoch + 1; if stream then stream.close(); stream = nil end end
    return api
end
return M