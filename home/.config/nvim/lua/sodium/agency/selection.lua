local M = {}

function M.select(result, valid, callback)
    local function choose(items, prompt, format, next_choice)
        if not valid() then return end
        vim.ui.select(items, { prompt = prompt, format_item = format }, vim.schedule_wrap(function(item)
            if item and valid() then next_choice(item) end
        end))
    end
    local function backend_chosen(backend)
        if not valid() then return end
        local defaults = vim.deepcopy(backend.defaults or {})
        local models = { { name = backend.discovery == "unavailable" and "Configured default (model discovery unavailable)" or "Configured default" } }
        vim.list_extend(models, backend.models or {})
        local prompt = backend.discovery == "cached"
            and "Agency model (cached; " .. (backend.discoveryError or "discovery is stale") .. ")" or "Agency model"
        choose(models, prompt, function(item)
            return (item.name or item.id) .. (backend.discovery == "cached" and item.id and " (cached)" or "")
        end, function(model)
            local selection = vim.tbl_deep_extend("force", defaults, model.selection or {})
            if model.selection and model.selection.configValues and model.selection.configValues.model then selection.modelId = nil end
            if model.selection and model.selection.modelId and selection.configValues then selection.configValues.model = nil end
            callback({ backend_id = backend.id, selection = selection })
        end)
    end
    if #result.backends == 1 and (not result.defaultBackendId or result.backends[1].id == result.defaultBackendId) then backend_chosen(result.backends[1])
    else choose(result.backends, "Agency backend", function(item)
        return item.id .. (item.id == result.defaultBackendId and " (default)" or "")
    end, backend_chosen) end
end

function M.settings(config, valid, report)
    local function available()
        local options = vim.deepcopy(config.options or {})
        local legacy = config.legacy_agent_modes
        if not config.mode and legacy and #legacy._modes > 0 then
            local values = {}
            for _, mode in ipairs(legacy._modes) do
                values[#values + 1] = { value = mode.id, name = mode.name, description = mode.description }
            end
            options[#options + 1] = { id = "mode", name = "Mode", currentValue = legacy.current_mode_id, options = values, legacy = true }
        end
        return options
    end
    local captured = available()
    local function current() return valid() and vim.deep_equal(captured, available()) end
    local function values(option)
        if option.type == "boolean" then return { { value = true, name = "Enabled" }, { value = false, name = "Disabled" } } end
        local result = {}
        local function add(items)
            for _, item in ipairs(items or {}) do
                if item.value ~= nil then result[#result + 1] = vim.deepcopy(item) else add(item.options) end
            end
        end
        add(option.options)
        return result
    end
    local options = {}
    for _, option in ipairs(captured) do if #values(option) > 0 then options[#options + 1] = option end end
    if #options == 0 then report("This agent has no adjustable settings"); return end
    local function label(option)
        for _, value in ipairs(values(option)) do if value.value == option.currentValue then return value.name or tostring(value.value) end end
        return tostring(option.currentValue)
    end
    vim.ui.select(options, { prompt = "Agency settings", format_item = function(option)
        return (option.name or option.id) .. " · " .. label(option)
    end }, vim.schedule_wrap(function(option)
        if not option or not current() then return end
        local choices = values(option)
        for index, value in ipairs(choices) do
            if value.value == option.currentValue then table.insert(choices, 1, table.remove(choices, index)); break end
        end
        vim.ui.select(choices, { prompt = "Agency " .. (option.name or option.id), format_item = function(value)
            return (value.name or tostring(value.value)) .. (value.value == option.currentValue and " (current)" or "")
                .. (value.description and " · " .. value.description or "")
        end }, vim.schedule_wrap(function(value)
            if not value or not current() or value.value == option.currentValue then return end
            if option.legacy then config:handle_mode_change(value.value, true)
            else config:handle_change(option.id, value.value) end
        end))
    end))
end

return M