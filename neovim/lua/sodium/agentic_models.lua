local M = {}

local provider_labels = {
    ["claude-agent-acp"] = "Claude",
    ["codex-acp"] = "Codex",
}

local cache
local discovering = false
local pending = {}

function M.parse(stdout)
    local decoded = vim.json.decode(stdout)
    local models = {}

    for _, model in ipairs(decoded.models or {}) do
        models[#models + 1] = {
            provider = model.provider,
            model_id = model.model_id,
            name = model.name,
            description = model.description,
            text = string.format("%s %s", provider_labels[model.provider] or model.provider, model.name),
        }
    end

    return models, decoded.errors or {}
end

function M.clear_cache()
    cache = nil
    discovering = false
    pending = {}
end

function M.discover(callback, system)
    if cache then
        vim.schedule(function()
            callback(cache.models, cache.errors)
        end)
        return
    end

    pending[#pending + 1] = callback
    if discovering then
        return
    end

    discovering = true
    local runner = system or vim.system
    local claude_path = vim.fn.resolve(vim.fn.exepath("claude"))
    local codex_path = vim.fn.resolve(vim.fn.exepath("codex"))
    runner({
        vim.fn.exepath("node"),
        vim.fn.expand("~/.dotfiles/node-bin/agent-model-catalog.mjs"),
    }, {
        text = true,
        env = {
            CLAUDE_CODE_EXECUTABLE = claude_path ~= "" and claude_path or nil,
            CODEX_PATH = codex_path ~= "" and codex_path or nil,
        },
    }, function(result)
        local models
        local errors

        if result.code == 0 then
            local ok, parsed_models, parsed_errors = pcall(M.parse, result.stdout or "")
            if ok then
                models = parsed_models
                errors = parsed_errors
            else
                errors = { parsed_models }
            end
        else
            errors = { result.stderr ~= "" and result.stderr or "Model discovery failed" }
        end

        vim.schedule(function()
            if models and #models > 0 then
                cache = { models = models, errors = errors }
            end

            discovering = false
            local callbacks = pending
            pending = {}
            for _, queued in ipairs(callbacks) do
                queued(models, errors)
            end
        end)
    end)
end

local function error_message(errors)
    local messages = {}
    for _, err in ipairs(errors or {}) do
        if type(err) == "table" then
            messages[#messages + 1] = string.format("%s: %s", err.provider or "provider", err.message or "failed")
        else
            messages[#messages + 1] = tostring(err)
        end
    end
    return table.concat(messages, "\n")
end

function M.pick(on_select)
    M.discover(function(models, errors)
        if not models or #models == 0 then
            local message = error_message(errors)
            if message == "" then
                message = "No Claude or Codex models were discovered"
            end
            vim.notify(message, vim.log.levels.ERROR, { title = "Agent model discovery" })
            return
        end

        if errors and #errors > 0 then
            vim.notify(error_message(errors), vim.log.levels.WARN, { title = "Agent model discovery" })
        end

        Snacks.picker({
            title = "Agent model",
            items = models,
            layout = { preset = "select", preview = false },
            on_show = function()
                vim.cmd.stopinsert()
            end,
            format = function(item)
                return {
                    { provider_labels[item.provider] or item.provider, "SnacksPickerDir" },
                    { "  " .. item.name },
                }
            end,
            confirm = function(picker, item)
                if not item then
                    return
                end
                picker:close()
                on_select(item)
            end,
        })
    end)
end

return M
