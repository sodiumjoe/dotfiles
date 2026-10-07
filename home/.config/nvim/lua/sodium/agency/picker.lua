local M = {}

local function no_preview(ctx)
    ctx.preview:reset()
end

local function fields(row)
    local record = row.record
    return record.definition.agentId,
        record.definition.backendId,
        (record.settings.configValues or {}).model or record.settings.modelId or "",
        record.definition.cwd,
        record.phase
end

function M.open(controller)
    local closed, polling, generation = false, false, 0
    local picker, timer
    local function refresh()
        if closed or polling then
            return
        end
        polling = true
        generation = generation + 1
        local token = generation
        controller.page({ allow_issues = true }, function(err, result)
            if closed or token ~= generation then
                return
            end
            polling = false
            local items = {}
            if err then
                items[1] = { text = err.message or err.code, issue = err }
            else
                local active = controller.snapshot()
                for _, row in ipairs(result.agents) do
                    if row.record.version == 3 and row.live and row.record.launch and row.record.launch ~= vim.NIL
                        and row.record.launch.handlerGeneration == result.handlerGeneration then
                        local id, provider, model, cwd, phase = fields(row)
                        local attached = active
                            and active.target.agentId == id
                            and active.target.handlerGeneration == row.record.launch.handlerGeneration
                            and active.target.providerGeneration == row.record.launch.providerGeneration
                        items[#items + 1] = {
                            id = id,
                            view = vim.deepcopy(row),
                            text = table.concat(
                                {
                                    id,
                                    provider .. "/" .. model,
                                    cwd,
                                    phase,
                                    row.cleanup,
                                    attached and (active.connected and "attached" or "disconnected") or "current",
                                },
                                " · "
                            ),
                        }
                    end
                end
                for _, issue in ipairs(result.issues) do
                    items[#items + 1] =
                        { issue = issue, text = "Issue: " .. (issue.path or "") .. " · " .. issue.message }
                end
            end
            picker.opts.items = items
            picker:find({ refresh = true })
        end)
    end
    local function inspect(item)
        controller.notify(vim.inspect(item and (item.view or item.issue)))
    end
    local function attach(p, item)
        local row = item and item.view
        if row and row.record.version == 3 and row.record.phase == "ready" and row.live then
            p:close()
            controller.attach(item.id, nil, vim.deepcopy(row))
        else
            inspect(item)
        end
    end
    picker = Snacks.picker({
        title = "Agency active agents",
        items = {},
        show_empty = true,
        format = "text",
        preview = no_preview,
        layout = { hidden = { "preview" } },
        confirm = attach,
        actions = {
            attach = function(p)
                attach(p, p:current())
            end,
            stop = function(p)
                local item = p:current()
                if item and item.view and item.view.record.version == 3 then
                    local selected = vim.deepcopy(item.view)
                    p:close()
                    controller.stop(selected)
                else
                    inspect(item)
                end
            end,
            refresh = refresh,
            help = function()
                controller.notify(
                    "Enter/C-a attach ready; C-s stop selected; M-r refresh; ? help. Transitional rows are inspectable only. Saved sessions: <leader>ar. New session: <leader>an."
                )
            end,
        },
        win = {
            input = {
                keys = {
                    ["<C-a>"] = { "attach", mode = { "n", "i" } },
                    ["<C-s>"] = { "stop", mode = { "n", "i" } },
                    ["<M-r>"] = { "refresh", mode = { "n", "i" } },
                    ["?"] = { "help", mode = "n" },
                },
            },
        },
        on_close = function()
            if closed then
                return
            end
            closed = true
            generation = generation + 1
            if timer then
                timer:stop()
                timer:close()
            end
        end,
    })
    timer = (controller.timer_factory or vim.uv.new_timer)()
    timer:start(5000, 5000, vim.schedule_wrap(refresh))
    refresh()
    return picker
end

function M.choices(client, initial, info, callback, controller)
    local done, refreshing, picker = false, false, nil
    local function items(choices, unavailable)
        local rows = {}
        for _, choice in ipairs(choices) do
            local selection = choice.selection
            rows[#rows + 1] = {
                choice = choice,
                text = table.concat(
                    {
                        selection.providerId,
                        choice.displayName,
                        selection.modelId,
                        selection.reasoning.kind == "none" and "none" or selection.reasoning.value,
                        selection.mode,
                        selection.permissionProfile,
                    },
                    " · "
                ),
            }
        end
        for _, value in ipairs(unavailable or {}) do
            rows[#rows + 1] = { text = value.providerId .. " · " .. value.reason }
        end
        rows[#rows + 1] = { refresh = true, text = "Refresh catalog explicitly (launches discovery processes)" }
        return rows
    end
    local refresh_id
    local function refresh()
        if refreshing or done then
            return
        end
        refreshing = true
        refresh_id = refresh_id or controller.uuid()
        client.command(
            { "model", "refresh", "--command-id", refresh_id, "--handler-generation", info.handlerGeneration },
            { cwd = info.cwd, timeout_ms = 50000 },
            function(err, envelope)
                if done then
                    return
                end
                if err then
                    refreshing = false
                    controller.notify((err.message or err.code) .. " · refresh command " .. refresh_id)
                    return
                end
                if
                    envelope.handlerGeneration ~= info.handlerGeneration
                    or envelope.result.command.commandId ~= refresh_id
                    or envelope.result.command.state ~= "completed"
                then
                    refreshing = false
                    controller.notify("Catalog refresh incomplete or generation changed · " .. refresh_id)
                    return
                end
                client.command({ "agent", "choices" }, { cwd = info.cwd }, function(error, result)
                    if done then
                        return
                    end
                    refreshing = false
                    if error or result.handlerGeneration ~= info.handlerGeneration then
                        controller.notify(error and (error.message or error.code) or "stale Handler")
                        return
                    end
                    for index = #initial, 1, -1 do
                        initial[index] = nil
                    end
                    vim.list_extend(initial, vim.deepcopy(result.result.choices))
                    refresh_id = nil
                    picker.opts.items = items(result.result.choices, result.result.unavailable)
                    picker:find({ refresh = true })
                end)
            end
        )
    end
    picker = Snacks.picker({
        title = "Agency new session",
        items = items(initial, info.unavailable),
        format = "text",
        preview = no_preview,
        layout = { hidden = { "preview" } },
        confirm = function(p, item)
            if not item then
                return
            end
            if item.refresh then
                refresh()
            elseif item.choice and not refreshing then
                done = true
                p:close()
                callback(item.choice)
            end
        end,
        actions = { refresh = refresh },
        win = { input = { keys = { ["<M-r>"] = { "refresh", mode = { "n", "i" } } } } },
        on_close = function()
            if not done then
                done = true
                callback(nil)
            end
        end,
    })
    return picker
end

return M