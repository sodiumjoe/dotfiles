local M = {}

local labels = { ["codex-acp"] = "Codex", ["claude-agent-acp"] = "Claude" }

function M.select(result, valid, callback)
    if not valid() then return end
    local backends = {}
    for _, backend in ipairs(result.backends) do
        if backend.id == result.defaultBackendId then table.insert(backends, 1, backend) else backends[#backends + 1] = backend end
    end
    local items = {}
    for _, backend in ipairs(backends) do
        local default = backend.discovery == "unavailable" and "Configured default (model discovery unavailable)" or "Configured default"
        items[#items + 1] = { backend = backend, model = { name = default } }
        for _, model in ipairs(backend.models or {}) do items[#items + 1] = { backend = backend, model = model } end
    end
    vim.ui.select(items, { prompt = "Agency model", format_item = function(item)
        local model = item.model
        return (labels[item.backend.id] or item.backend.id) .. " · " .. (model.name or model.id)
    end }, vim.schedule_wrap(function(item)
        if not item or not valid() then return end
        local model = item.model
        local selection = vim.tbl_deep_extend("force", vim.deepcopy(item.backend.defaults or {}), model.selection or {})
        if model.selection and model.selection.configValues and model.selection.configValues.model then selection.modelId = nil end
        if model.selection and model.selection.modelId and selection.configValues then selection.configValues.model = nil end
        callback({ backend_id = item.backend.id, selection = selection })
    end))
end

function M.settings(config, valid, report)
    local function available()
        local options = vim.deepcopy(config.options or {})
        local legacy = config.legacy_agent_modes
        local modes = legacy and legacy:save().modes or {}
        if not config.mode and #modes > 0 then
            local values = {}
            for _, mode in ipairs(modes) do
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