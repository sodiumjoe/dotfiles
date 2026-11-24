local M = {}
local List = require("sodium.agency.session_list")

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
    local same = active and active.target.agentId == id
        and active.target.handlerGeneration == row.record.launch.handlerGeneration
        and active.target.providerGeneration == row.record.launch.providerGeneration
    local activity = display.activity or (same and (active.busy and "working" or "idle") or nil)
    local status = ({ starting = "Starting", restoring = "Restoring", stopping = "Stopping",
        recoverable = "Needs recovery" })[phase]
        or (activity == "working" and "Working" or activity == "idle" and "Waiting for input" or "Running")
    local location = same and (active.connected and "Open in this session" or "Editor disconnected") or "Available to open"
    local backend = ({ ["codex-acp"] = "Codex", ["claude-agent-acp"] = "Claude" })[provider] or provider
    local item = List.item(row, { status = status == "Waiting for input" and "Idle" or status, status_detail = status })
    item.preview[#item.preview + 1] = string.format("%-14s%s", "Connection:", location)
    local details = table.concat({ backend .. (model ~= "" and "/" .. model or ""), vim.fn.fnamemodify(cwd, ":~"), status, location }, " · ")
    local short = vim.fn.strchars(item.title) > 72 and vim.fn.strcharpart(item.title, 0, 71) .. "…" or item.title
    item.search_text, item.text = item.title .. " · " .. details, short .. " · " .. details
    return item
end

local function diagnostic_item(name, message, issue, hosts, status)
    local preview = { "[" .. name .. "]", message, "" }
    if hosts then
        for _, host in ipairs(hosts) do
            vim.list_extend(preview, { "Host: " .. host.hostname, "Host ID: " .. host.hostId })
            if host.code then preview[#preview + 1] = "Error: " .. host.code end
            if host.error then preview[#preview + 1] = "Reason: " .. host.error end
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

local function short(hostname)
    local first = hostname:match("^[^.]+") or hostname
    return vim.fn.strchars(first) > 16 and vim.fn.strcharpart(first, 0, 16) .. "…" or first
end

local function owner_item(host, row, local_host, active, name)
    local record, launch = row.record, row.record.launch
    if record.version ~= 3 or not launch or launch == vim.NIL then
        return diagnostic_item(name, "Unavailable session", row, { host })
    end
    local item = row_item(row, local_host and active or nil)
    if not local_host then item.excerpt.hostId, item.remote = host.hostId, true end
    item.id = host.hostId .. ":" .. record.definition.agentId
    item.label = name
    item.text = "[" .. name .. "] · " .. item.search_text .. " · " .. item.status .. " · " .. host.hostname
    if not local_host then item.preview[#item.preview + 1] = "Remote: " .. name end
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
    local base = "Agency active agents"
    local closed, local_pending, published = false, true, false
    local remote_pending = controller.read_roster and 1 or 0
    local picker, roster, unavailable, local_generation, publication
    local local_rows, local_issues = {}, {}
    local function progress() List.loading(picker, base, local_pending or remote_pending > 0) end
    local function render()
        progress()
        if closed or local_pending or not picker or published and remote_pending > 0 then return end
        local items, diagnostics, active = {}, {}, controller.snapshot()
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
                local name = is_local and "local" or host.name or short(host.hostname)
                if host.state == "unavailable" then
                    local message = host.code == "OFFLINE" and host.since and "Offline since " .. os.date("%H:%M", math.floor(host.since / 1000))
                        or ({ UPDATE_REQUIRED = "Update this devbox", CONNECTING = "Connecting" })[host.code] or "Unavailable"
                    local status = ({ UPDATE_REQUIRED = "Outdated", CONNECTING = "Connecting" })[host.code] or "Offline"
                    diagnostics[#diagnostics + 1] = diagnostic_item(name, message, host, { host }, status)
                else
                    if not is_local or #local_rows == 0 then
                        for _, row in ipairs(host.value.agents) do
                            local item = owner_item(host, row, is_local, active, name)
                            local destination = item.issue and diagnostics or items
                            destination[#destination + 1] = item
                        end
                    end
                    for _, issue in ipairs(host.value.issues) do
                        diagnostics[#diagnostics + 1] = diagnostic_item(name, issue.message, issue, { host })
                    end
                end
            end
        elseif remote_pending == 0 and unavailable then diagnostics[#diagnostics + 1] = diagnostic_item("remotes", "Owner reads unavailable", { code = unavailable }) end
        List.order(items)
        vim.list_extend(items, diagnostics)
        picker._agency_label_width = 7
        for _, item in ipairs(items) do
            item.group = item.issue and 1 or 0
            picker._agency_label_width = math.max(picker._agency_label_width, vim.fn.strdisplaywidth(item.label) + 2)
        end
        local selected = picker.list.win:valid() and picker:current()
        publication = selected and { key = selected.id or selected.text,
            pattern = picker.input.filter.pattern, search = picker.input.filter.search } or nil
        published = true
        picker.opts.items = items
        picker:find({ refresh = true })
    end
    local function load_local()
        controller.page({ active = true }, function(err, result)
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
            local valid = controller.selection_guard and controller.selection_guard() or function() return true end
            after_close(p, valid,
                function() if ref then controller.enter_remote(ref) else controller.attach(id, nil, selected) end end, controller.notify)
        else inspect(item) end
    end
    picker = Snacks.picker({
        title = base, items = {}, show_empty = true, format = List.format, preview = List.preview(controller.excerpt), confirm = attach,
        sort = { fields = { "group", "score:desc", "epoch:desc", "idx" } },
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
                    local selected = vim.deepcopy(item.view)
                    local valid = controller.selection_guard and controller.selection_guard() or function() return true end
                    after_close(p, valid,
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
    progress()
    load_local()
    load_owners()
    return picker
end

return M