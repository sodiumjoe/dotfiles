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
        choose(models, "Agency model", function(item) return item.name or item.id end, function(model)
            local selection = vim.tbl_deep_extend("force", defaults, model.selection or {})
            if model.selection and model.selection.configValues and model.selection.configValues.model then selection.modelId = nil end
            if model.selection and model.selection.modelId and selection.configValues then selection.configValues.model = nil end
            local settings = vim.deepcopy(model.settings or {})
            vim.list_extend(settings, backend.settings or {})
            local function setting_at(index)
                if not valid() then return end
                local setting = settings[index]
                if not setting then callback({ backend_id = backend.id, selection = selection }); return end
                local configured = setting.kind == "field" and selection[setting.id] or (selection.configValues or {})[setting.id]
                if configured == nil and setting.id == "mode" then configured = selection.modeId end
                local supported = configured == nil
                for _, value in ipairs(setting.values or {}) do
                    if value.value == configured then supported = true end
                end
                local values = supported and { { name = "Configured default" } } or {}
                vim.list_extend(values, setting.values or {})
                choose(values, "Agency " .. setting.name, function(item) return item.name or tostring(item.value) end, function(value)
                    if value.value ~= nil then
                        if setting.kind == "field" then selection[setting.id] = value.value
                        else
                            selection.configValues = selection.configValues or {}
                            selection.configValues[setting.id] = value.value
                            if setting.id == "model" then selection.modelId = nil end
                            if setting.id == "mode" then selection.modeId = nil end
                        end
                    end
                    setting_at(index + 1)
                end)
            end
            setting_at(1)
        end)
    end
    if #result.backends == 1 and (not result.defaultBackendId or result.backends[1].id == result.defaultBackendId) then backend_chosen(result.backends[1])
    else choose(result.backends, "Agency backend", function(item)
        return item.id .. (item.id == result.defaultBackendId and " (default)" or "")
    end, backend_chosen) end
end

return M