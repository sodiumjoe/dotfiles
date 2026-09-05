local M = {}

local providers = {
    { id = "claude-agent-acp", label = "Claude" },
    { id = "codex-acp", label = "Codex" },
}

local provider_labels = {
    ["claude-agent-acp"] = "Claude",
    ["codex-acp"] = "Codex",
}

local states = {}
local discovering = false
local listeners = {}

local function reset_states()
    states = {}
    for _, provider in ipairs(providers) do
        states[provider.id] = { status = "loading" }
    end
end

reset_states()

local function complete()
    for _, provider in ipairs(providers) do
        if states[provider.id].status == "loading" then
            return false
        end
    end
    return true
end

function M.items()
    local items = {}
    for _, provider in ipairs(providers) do
        local state = states[provider.id]
        if state.status == "ready" then
            vim.list_extend(items, state.models)
        elseif state.status == "error" then
            items[#items + 1] = {
                provider = provider.id,
                name = state.error.message,
                text = provider.label .. " " .. state.error.message,
                status = "error",
            }
        else
            items[#items + 1] = {
                provider = provider.id,
                name = "Loading…",
                text = provider.label .. " Loading",
                status = "loading",
            }
        end
    end
    return items
end

function M.parse_event(line)
    local decoded = vim.json.decode(line)
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
    return { provider = decoded.provider, models = models, error = decoded.error }
end

local function publish()
    local items = M.items()
    local is_complete = complete()
    local current = listeners
    if is_complete then
        listeners = {}
        discovering = false
    end
    for _, listener in ipairs(current) do
        listener(items, is_complete)
    end
end

local function apply_event(event)
    local state = states[event.provider]
    if not state or state.status ~= "loading" then
        return
    end
    if event.error then
        states[event.provider] = { status = "error", error = event.error }
    elseif #event.models == 0 then
        states[event.provider] = {
            status = "error",
            error = {
                provider = provider_labels[event.provider] or event.provider,
                message = "No models discovered",
            },
        }
    else
        states[event.provider] = { status = "ready", models = event.models }
    end
    publish()
end

local function fail_loading(message)
    for _, provider in ipairs(providers) do
        if states[provider.id].status == "loading" then
            states[provider.id] = {
                status = "error",
                error = { provider = provider.label, message = message },
            }
        end
    end
    publish()
end

function M.clear_cache()
    reset_states()
    discovering = false
    listeners = {}
end

function M.discover(callback, system)
    local is_complete = complete()
    vim.schedule(function()
        callback(M.items(), is_complete)
    end)
    if is_complete then
        return
    end

    listeners[#listeners + 1] = callback
    if discovering then
        return
    end

    discovering = true
    local runner = system or vim.system
    local claude_path = vim.fn.resolve(vim.fn.exepath("claude"))
    local codex_path = vim.fn.resolve(vim.fn.exepath("codex"))
    local buffer = ""

    runner({
        vim.fn.exepath("node"),
        vim.fn.expand("~/.dotfiles/node-bin/agent-model-catalog.mjs"),
    }, {
        text = true,
        env = {
            CLAUDE_CODE_EXECUTABLE = claude_path ~= "" and claude_path or nil,
            CODEX_PATH = codex_path ~= "" and codex_path or nil,
        },
        stdout = function(err, data)
            if err then
                vim.schedule(function()
                    fail_loading(err)
                end)
                return
            end
            buffer = buffer .. (data or "")
            while true do
                local newline = buffer:find("\n", 1, true)
                if not newline then
                    break
                end
                local line = vim.trim(buffer:sub(1, newline - 1))
                buffer = buffer:sub(newline + 1)
                if line ~= "" then
                    local ok, event = pcall(M.parse_event, line)
                    vim.schedule(function()
                        if ok then
                            apply_event(event)
                        else
                            fail_loading(tostring(event))
                        end
                    end)
                end
            end
        end,
    }, function(result)
        vim.schedule(function()
            if not complete() then
                local message = result.stderr and result.stderr ~= "" and result.stderr or "Model discovery failed"
                fail_loading(message)
            end
        end)
    end)
end

function M.pick(on_select, system)
    local items = M.items()
    local picker
    picker = Snacks.picker({
        title = "Agent model",
        finder = function()
            return items
        end,
        layout = { preset = "select", preview = false },
        on_show = function()
            vim.cmd.startinsert()
        end,
        format = function(item)
            local label = provider_labels[item.provider] or item.provider
            if item.status == "loading" then
                return { { label, "SnacksPickerDir" }, { "  Loading…", "Comment" } }
            end
            if item.status == "error" then
                return { { label, "SnacksPickerDir" }, { "  " .. item.name, "DiagnosticError" } }
            end
            return { { label, "SnacksPickerDir" }, { "  " .. item.name } }
        end,
        confirm = function(current_picker, item)
            if not item or item.status then
                return
            end
            current_picker:close()
            on_select(item)
        end,
    })

    M.discover(function(updated)
        items = updated
        if picker and not picker.closed then
            picker:refresh()
        end
    end, system)
end

return M
