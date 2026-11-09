local M = {}

local function no_preview(ctx)
    ctx.preview:reset()
end

local function agent_preview(ctx)
    ctx.preview:reset()
    if not ctx.item then return end
    local lines = ctx.item.preview or vim.split(vim.inspect(ctx.item.issue), "\n")
    ctx.preview:set_lines(lines)
end

local function fields(row)
    local record = row.record
    return record.definition.agentId,
        record.definition.backendId,
        (record.settings.configValues or {}).model or record.settings.modelId or "",
        record.definition.cwd,
        record.phase
end

local function row_item(row, active)
    local id, provider, model, cwd, phase = fields(row)
    local display = type(row.display) == "table" and row.display or {}
    local title, metadata = require("sodium.agentic_sessions").parse_title(display.title, true)
    title = vim.trim(title:gsub("%c", " "):gsub("%s+", " "))
    if title == "" then title = "New conversation" end
    local same = active and active.target.agentId == id
        and active.target.handlerGeneration == row.record.launch.handlerGeneration
        and active.target.providerGeneration == row.record.launch.providerGeneration
    local activity = display.activity or (same and (active.busy and "working" or "idle") or nil)
    local status = ({ starting = "Starting", restoring = "Restoring", stopping = "Stopping",
        recoverable = "Needs recovery" })[phase]
        or (activity == "working" and "Working" or activity == "idle" and "Waiting for input" or "Running")
    local location = same and (active.connected and "Open in this tab" or "Editor disconnected") or "Available to open"
    local backend = ({ ["codex-acp"] = "Codex", ["claude-agent-acp"] = "Claude" })[provider] or provider
    local preview = { title, "" }
    for _, field in ipairs({
        { "Agent ID:", id },
        { "Backend:", backend },
        { "Model:", model },
        { "Directory:", cwd },
        { "Status:", status },
        { "Connection:", location },
        { "Project root:", metadata.project_root },
        { "Branch:", metadata.branch },
        { "Plan:", metadata.plan },
        { "Platform:", metadata.platform },
        { "Editor:", metadata.editor },
        { "Shell:", metadata.shell },
    }) do
        if field[2] and field[2] ~= "" then
            preview[#preview + 1] = string.format("%-14s%s", field[1], field[2])
        end
    end
    local full_title = title
    local details = table.concat({ backend .. (model ~= "" and "/" .. model or ""),
        vim.fn.fnamemodify(cwd, ":~"), status, location }, " · ")
    if vim.fn.strchars(title) > 72 then title = vim.fn.strcharpart(title, 0, 71) .. "…" end
    return { id = id, view = vim.deepcopy(row), preview = preview, title = full_title, label = "local",
        status = status == "Waiting for input" and "Idle" or status, search_text = full_title .. " · " .. details,
        text = title .. " · " .. details }
end

local function clip(value, width)
    if width <= 0 then return "" end
    if vim.fn.strdisplaywidth(value) <= width then return value end
    local text = vim.fn.strcharpart(value, 0, width - 1)
    while vim.fn.strdisplaywidth(text) > width - 1 do text = vim.fn.strcharpart(text, 0, vim.fn.strchars(text) - 1) end
    return text .. "…"
end

local function column(value, width)
    local text = clip(value, width)
    return text .. string.rep(" ", math.max(0, width - vim.fn.strdisplaywidth(text)))
end

local function active_format(item, picker)
    return { { "", resolve = function(width)
        width = math.max(1, width - 1)
        if width < 12 then return { { clip("[" .. item.label .. "] " .. item.title, width) } } end
        local label_width = math.min(picker._agency_label_width or 32, 32, math.floor(width / 3))
        local status_width = math.min(9, math.floor(width / 4))
        local title_width = width - label_width - status_width - 4
        local label = "[" .. clip(item.label, label_width - 2) .. "]"
        local status_hl = item.issue and "DiagnosticWarn" or item.status == "Working" and "DiagnosticInfo" or "Comment"
        return { { column(label, label_width), "Identifier" }, { "  " },
            { column(item.title, title_width) }, { "  " }, { column(item.status, status_width), status_hl } }
    end } }
end

local function diagnostic_item(name, message, issue, hosts, status)
    local preview = { "[" .. name .. "]", message, "" }
    if hosts then
        for _, host in ipairs(hosts) do
            vim.list_extend(preview, { "Host: " .. host.hostname, "Host ID: " .. host.hostId })
            if host.code then preview[#preview + 1] = "Error: " .. host.code end
            preview[#preview + 1] = ""
        end
    end
    vim.list_extend(preview, vim.split(vim.inspect(issue), "\n"))
    return { label = name, title = message, status = status or "Issue", preview = preview, issue = vim.deepcopy(issue),
        text = table.concat({ name, message, vim.inspect(issue) }, " ") }
end

local function after_close(picker, valid, callback, notify)
    local windows = {}
    if picker.layout then
        for _, win in ipairs(picker.layout:get_wins()) do
            if win.win then windows[#windows + 1] = win.win end
            if win.backdrop and win.backdrop.win then windows[#windows + 1] = win.backdrop.win end
        end
    end
    local deadline = vim.uv.hrtime() + 2000000000
    picker:close()
    local function finish()
        if not valid() then return end
        for _, win in ipairs(windows) do
            if vim.api.nvim_win_is_valid(win) then
                if vim.uv.hrtime() < deadline then vim.defer_fn(finish, 10)
                elseif notify then notify("Picker windows did not close; action cancelled") end
                return
            end
        end
        callback()
    end
    vim.schedule(finish)
end

function M.current(agents, callback)
    local confirmed, completed = false, false
    local function complete(view)
        if completed then return end
        completed = true
        callback(view)
    end
    local items = {}
    for _, row in ipairs(agents) do items[#items + 1] = row_item(row) end
    return Snacks.picker({
        title = "Agency conversations", items = items, format = "text", preview = agent_preview,
        confirm = function(picker, item)
            if not item or confirmed or completed then return end
            confirmed = true
            local view = vim.deepcopy(item.view)
            after_close(picker, function() return not completed end, function() complete(view) end, function(message)
                vim.notify("Agency: " .. message)
                complete(nil)
            end)
        end,
        on_close = function()
            if not confirmed then vim.schedule(function() complete(nil) end) end
        end,
    })
end

local function owner_item(host, row, local_host, active, name)
    name = name or "unnamed remote"
    local record, launch = row.record, row.record.launch
    if record.version ~= 3 or not launch or launch == vim.NIL then
        return diagnostic_item(name, "Unavailable session", row, { host })
    end
    local item = row_item(row, local_host and active or nil)
    item.id = host.hostId .. ":" .. record.definition.agentId
    item.label = name
    item.text = "[" .. name .. "] · " .. item.search_text .. " · " .. item.status .. " · " .. host.hostname
    if not local_host and name ~= "unnamed remote" then item.preview[#item.preview + 1] = "Remote: " .. name end
    vim.list_extend(item.preview, { "Host: " .. host.hostname, "Host ID: " .. host.hostId })
    if not local_host then
        item.owner, item.view = vim.deepcopy(row), nil
        if row.live and record.phase == "ready" and launch.handlerGeneration == host.value.handlerGeneration then
            item.remote_ref = { hostId = host.hostId, target = { agentId = record.definition.agentId,
                handlerGeneration = launch.handlerGeneration, providerGeneration = launch.providerGeneration } }
        end
    end
    return item
end

function M.open(controller)
    local read_names = controller.read_roster and controller.read_remote_names
    local closed, local_pending, published = false, true, false
    local remote_pending = (controller.read_roster and 1 or 0) + (read_names and 1 or 0)
    local picker, roster, unavailable, local_generation, publication
    local local_rows, local_issues, names = {}, {}, {}
    local function render()
        if closed or local_pending or not picker or published and remote_pending > 0 then return end
        local items, diagnostics, unlisted, active = {}, {}, {}, controller.snapshot()
        for _, row in ipairs(local_rows) do
            if row.record.version == 3
                and (row.record.phase == "ready" and row.live or vim.tbl_contains({ "starting", "restoring", "stopping" }, row.record.phase))
                and row.record.launch and row.record.launch ~= vim.NIL
                and row.record.launch.handlerGeneration == local_generation then
                local item = row_item(row, active)
                item.text = "[local] · " .. item.search_text .. " · " .. item.status
                items[#items + 1] = item
            end
        end
        for _, issue in ipairs(local_issues) do
            diagnostics[#diagnostics + 1] = diagnostic_item("local", issue.message or issue.code or "Unavailable", issue)
        end
        if remote_pending == 0 and roster then
            for _, host in ipairs(roster.hosts) do
                local is_local = host.hostId == roster.localHostId
                local name = is_local and "local" or names[host.hostname]
                if host.state == "unavailable" then
                    if not name then unlisted[#unlisted + 1] = host
                    else
                        local message = host.code == "BRIDGE_EOF" and "Connection closed" or "Unavailable"
                        diagnostics[#diagnostics + 1] = diagnostic_item(name, message, host, { host }, "Offline")
                    end
                else
                    if not is_local or #local_rows == 0 then
                        for _, row in ipairs(host.value.agents) do
                            local item = owner_item(host, row, is_local, active, name)
                            local destination = item.issue and diagnostics or items
                            destination[#destination + 1] = item
                        end
                    end
                    for _, issue in ipairs(host.value.issues) do
                        diagnostics[#diagnostics + 1] = diagnostic_item(name or "unnamed remote", issue.message, issue, { host })
                    end
                end
            end
        elseif remote_pending == 0 and unavailable then diagnostics[#diagnostics + 1] = diagnostic_item("remotes", "Owner reads unavailable", { code = unavailable }) end
        if #unlisted > 0 then
            local message = #unlisted .. " saved host" .. (#unlisted == 1 and "" or "s") .. " unavailable"
            local item = diagnostic_item("unlisted remotes", message, { hosts = unlisted }, unlisted, "Offline")
            table.insert(item.preview, 4, "No friendly name was resolved for these saved hosts.")
            diagnostics[#diagnostics + 1] = item
        end
        local first_session = picker.list.reverse and #diagnostics + 1 or 1
        if picker.list.reverse then
            vim.list_extend(diagnostics, items)
            items = diagnostics
        else vim.list_extend(items, diagnostics) end
        picker._agency_label_width = 7
        for _, item in ipairs(items) do
            item.group = item.issue and (picker.list.reverse and 0 or 1) or (picker.list.reverse and 1 or 0)
            picker._agency_label_width = math.max(picker._agency_label_width, vim.fn.strdisplaywidth(item.label) + 2)
        end
        local selected = picker.list.win:valid() and picker:current()
        publication = selected and { key = selected.id or selected.text,
            pattern = picker.input.filter.pattern, search = picker.input.filter.search } or nil
        published = true
        picker.opts.items = items
        if not publication and picker.list.reverse and #items >= first_session and picker.input.filter.pattern == "" then
            picker.list:set_target(first_session)
        end
        picker:find({ refresh = true })
    end
    local function load_local()
        controller.page({ allow_issues = true, active = true }, function(err, result)
            if closed then return end
            if err then local_rows, local_issues = {}, { err }
            else local_rows, local_issues, local_generation = result.agents, result.issues, result.handlerGeneration end
            local_pending = false
            render()
        end)
    end
    local function load_owners()
        if not controller.read_roster then return end
        controller.read_roster(function(err, result)
            if closed then return end
            if err then roster, unavailable = nil, err.code
            elseif type(result) ~= "table" or result.state ~= "roster" or type(result.hosts) ~= "table" then roster, unavailable = nil, "INVALID_PROTOCOL"
            else roster, unavailable = result, nil end
            remote_pending = remote_pending - 1
            render()
        end)
    end
    local function inspect(item) controller.notify(vim.inspect(item and (item.owner or item.view or item.issue))) end
    local function actionable(item)
        return item and (item.remote_ref ~= nil or item.view ~= nil)
    end
    local function attach(p, item)
        if publication then return end
        local row = item and item.view
        if not actionable(item) then inspect(item); return end
        if item.remote_ref or row and row.record.version == 3 and row.record.phase == "ready" and row.live then
            local id, selected, ref = row and row.record.definition.agentId, vim.deepcopy(row), vim.deepcopy(item.remote_ref)
            local tab = vim.api.nvim_get_current_tabpage()
            local valid = controller.selection_guard and controller.selection_guard() or function() return true end
            after_close(p, function() return valid() and vim.api.nvim_tabpage_is_valid(tab) and vim.api.nvim_get_current_tabpage() == tab end,
                function() if ref then controller.enter_remote(ref) else controller.attach(id, nil, selected) end end, controller.notify)
        else inspect(item) end
    end
    picker = Snacks.picker({
        title = "Agency active agents", items = {}, show_empty = true, format = active_format, preview = agent_preview, confirm = attach,
        sort = { fields = { "group", "score:desc", "idx" } },
        matcher = { on_done = function()
            if closed or not picker or picker:is_active() then return end
            local prior = publication
            publication = nil
            if prior and prior.key and prior.pattern == picker.input.filter.pattern and prior.search == picker.input.filter.search then
                for index = 1, picker.list:count() do
                    local item = picker.list:get(index)
                    if (item.id or item.text) == prior.key then picker.list:view(index); return end
                end
            end
            if not picker.list.reverse then return end
            local selected = picker:current()
            if not selected or not selected.issue then return end
            for index = 1, picker.list:count() do
                if not picker.list:get(index).issue then picker.list:view(index); return end
            end
        end },
        actions = {
            attach = function(p) attach(p, p:current()) end,
            stop = function(p)
                local item = p:current()
                if actionable(item) and item.view and item.view.record.version == 3 then
                    if publication then return end
                    local selected, tab = vim.deepcopy(item.view), vim.api.nvim_get_current_tabpage()
                    local valid = controller.selection_guard and controller.selection_guard() or function() return true end
                    after_close(p, function() return valid() and vim.api.nvim_tabpage_is_valid(tab) and vim.api.nvim_get_current_tabpage() == tab end,
                        function() controller.stop(selected) end, controller.notify)
                else inspect(item) end
            end,
            help = function() controller.notify("Enter/C-a attach ready; C-s stop local selected; ? help. Reopen <leader>af for a fresh snapshot. Disconnected and transitional rows are inspectable. Saved sessions: <leader>ar. New session: <leader>an.") end,
        },
        win = { input = { keys = { ["<C-a>"] = { "attach", mode = { "n", "i" } }, ["<C-s>"] = { "stop", mode = { "n", "i" } },
            ["?"] = { "help", mode = "n" } } }, list = { keys = { ["<C-s>"] = "stop" } } },
        on_close = function()
            closed = true
        end,
    })
    load_local()
    load_owners()
    if read_names then
        read_names(function(result)
            if closed then return end
            names = result or {}
            remote_pending = remote_pending - 1
            render()
        end)
    end
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