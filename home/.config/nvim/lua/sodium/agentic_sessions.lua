local M = {}

local metadata_keys = {
    ["Project root"] = "project_root",
    ["Current branch"] = "branch",
    Platform = "platform",
    Editor = "editor",
    Shell = "shell",
}

local function days_from_civil(year, month, day)
    year = tonumber(year)
    month = tonumber(month)
    day = tonumber(day)

    if month <= 2 then
        year = year - 1
    end

    local era = math.floor(year / 400)
    local year_of_era = year - era * 400
    local month_prime = month + (month > 2 and -3 or 9)
    local day_of_year = math.floor((153 * month_prime + 2) / 5) + day - 1
    local day_of_era = year_of_era * 365 + math.floor(year_of_era / 4) - math.floor(year_of_era / 100) + day_of_year

    return era * 146097 + day_of_era - 719468
end

local function session_updated_at_sort_key(updated_at)
    if type(updated_at) ~= "string" then
        return nil
    end

    local year, month, day, hour, min, sec, remainder =
        updated_at:match("^(%d%d%d%d)%-(%d%d)%-(%d%d)T(%d%d):(%d%d):(%d%d)(.*)$")
    if not year then
        return nil
    end

    year = tonumber(year)
    month = tonumber(month)
    day = tonumber(day)
    hour = tonumber(hour)
    min = tonumber(min)
    sec = tonumber(sec)
    local leap_year = year % 4 == 0 and (year % 100 ~= 0 or year % 400 == 0)
    local days_in_month = {
        31,
        leap_year and 29 or 28,
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    }
    if
        month < 1
        or month > 12
        or day < 1
        or day > days_in_month[month]
        or hour > 23
        or min > 59
        or sec > 59
    then
        return nil
    end

    local fraction
    local zone
    if remainder ~= "" then
        local maybe_fraction, maybe_zone = remainder:match("^(%.%d+)(.*)$")
        if maybe_fraction then
            fraction = maybe_fraction
            remainder = maybe_zone
        end

        if remainder == "Z" or remainder == "z" then
            zone = remainder
        elseif remainder ~= "" then
            local sign, zone_hour, zone_min = remainder:match("^([%+%-])(%d%d):?(%d%d)$")
            if not sign then
                return nil
            end

            zone = sign .. zone_hour .. zone_min
        end
    end

    local offset = 0
    if zone and zone ~= "Z" and zone ~= "z" then
        local sign, zone_hour, zone_min = zone:match("^([%+%-])(%d%d):?(%d%d)$")
        if not sign then
            return nil
        end

        if tonumber(zone_hour) > 23 or tonumber(zone_min) > 59 then
            return nil
        end

        offset = (tonumber(zone_hour) * 60 + tonumber(zone_min)) * 60
        if sign == "-" then
            offset = -offset
        end
    end

    local seconds = days_from_civil(year, month, day) * 86400
        + hour * 3600
        + min * 60
        + sec
        - offset
    local fractional = fraction and tonumber(fraction) or 0

    return seconds + fractional
end

local function file_uri_to_path(uri)
    local ok, path = pcall(vim.uri_to_fname, uri)
    return ok and path or uri:gsub("^file://", "")
end

function M.parse_title(raw_title, allow_incomplete_environment)
    local raw = type(raw_title) == "string" and raw_title or ""
    local metadata = {}
    local environment = raw:match("<environment_info>%s*(.-)%s*</environment_info>")
        or allow_incomplete_environment and raw:match("<environment_info>%s*(.*)$")

    if environment then
        environment = environment:gsub("%s+%- ", "\n- ")
        for line in environment:gmatch("[^\r\n]+") do
            local key, value = line:match("^%- ([^:]+):%s*(.*)$")
            local normalized_key = key and metadata_keys[key]
            if normalized_key and value ~= "" then
                metadata[normalized_key] = value
            end
        end
    end

    for label, uri in raw:gmatch("%[@([^%]]+)%]%((file://[^%)]+)%)") do
        local path = file_uri_to_path(uri)
        if not metadata.plan and (label:match("%.md$") or path:find("/stripe/work/projects/", 1, true)) then
            metadata.plan = path
        end
    end

    local title = raw
        :gsub("<environment_info>.-</environment_info>", " ")
        :gsub("%[@[^%]]+%]%((file://[^%)]+)%)", " ")
        :gsub("%s+", " ")
    if allow_incomplete_environment then
        title = title:gsub("<environment_info>.*$", " ")
    end
    title = vim.trim(title)

    return title, metadata
end

function M.normalize_session(session)
    local title, metadata = M.parse_title(session.title, true)
    title = vim.trim(title:gsub("%c", " "):gsub("%s+", " "))
    if title == "" or title == "New conversation" then
        title = "Untitled session " .. (session.sessionId or session.nativeSessionId or "unknown"):gsub("^agency:", ""):sub(1, 8)
    end
    local display_title = vim.fn.strchars(title) > 48 and vim.fn.strcharpart(title, 0, 47) .. "…" or title
    local directory = type(session.cwd) == "string" and vim.fn.fnamemodify(session.cwd, ":~") or ""
    local updated_at = type(session.updatedAt) == "string"
            and session.updatedAt:sub(1, 16):gsub("T", " ")
        or "unknown date"

    local agency = session._meta and session._meta.agency or {}
    local backend = session.backendId or agency.backendId
    local unavailable = session.unavailable == true or agency.unavailable == true or agency.recordVersion == 1
        or session.unavailable == nil and backend ~= nil and backend ~= "codex-acp"
    local availability = unavailable and "Unavailable" or backend and "Available" or nil
    local labels = (backend and " [" .. backend .. "]" or "") .. (unavailable and " [Unavailable]" or "")
    return {
        session_id = session.sessionId or session.nativeSessionId,
        native_session_id = session.nativeSessionId,
        saved_native_session_id = agency.nativeSessionId,
        backend_id = backend,
        cwd = session.cwd,
        phase = agency.phase,
        unavailable = unavailable,
        availability = availability,
        unavailable_reason = agency.unavailableReason or (agency.recordVersion == 1 and "Legacy record (version 1)" or nil),
        labels = labels,
        original_title = session.title,
        title = title,
        display_title = display_title,
        directory = directory,
        updated_at = updated_at,
        sort_key = session_updated_at_sort_key(session.updatedAt),
        metadata = metadata,
        text = table.concat({ title, directory, updated_at, labels }, " "),
    }
end

function M.normalize_sessions(sessions)
    local items = {}
    for index, session in ipairs(sessions or {}) do
        local item = M.normalize_session(session)
        item.original_index = index
        items[index] = item
    end

    table.sort(items, function(left, right)
        if left.sort_key ~= nil and right.sort_key ~= nil and left.sort_key ~= right.sort_key then
            return left.sort_key > right.sort_key
        end
        if left.sort_key ~= nil and right.sort_key == nil then
            return true
        end
        if left.sort_key == nil and right.sort_key ~= nil then
            return false
        end
        return left.original_index < right.original_index
    end)

    return items
end

function M.preview_lines(item)
    local lines = { item.title, "", string.format("%-14s%s", "Updated:", item.updated_at) }
    local context = {
        { "Directory:", item.cwd },
        { "Backend:", item.backend_id },
        { "Availability:", item.availability },
        { "Reason:", item.unavailable_reason },
        { "State:", item.phase },
        { "Project root:", item.metadata.project_root },
        { "Branch:", item.metadata.branch },
        { "Plan:", item.metadata.plan },
    }
    local environment = {
        { "Platform:", item.metadata.platform },
        { "Editor:", item.metadata.editor },
        { "Shell:", item.metadata.shell },
    }

    local function append_fields(fields)
        local appended = false
        for _, field in ipairs(fields) do
            if type(field[2]) == "string" and field[2] ~= "" then
                lines[#lines + 1] = string.format("%-14s%s", field[1], field[2])
                appended = true
            end
        end
        return appended
    end

    local has_context = append_fields(context)
    if has_context and vim.tbl_contains(vim.tbl_map(function(field)
        return field[2] ~= nil
    end, environment), true) then
        lines[#lines + 1] = ""
    end
    append_fields(environment)
    lines[#lines + 1] = string.format("%-14s%s", "Session ID:", item.session_id or "unknown")
    if type(item.saved_native_session_id) == "string" then
        lines[#lines + 1] = string.format("%-14s%s", "Native ID:", item.saved_native_session_id)
    end
    return lines
end

local function with_conflict_check(current_session, on_restore)
    local has_conflict = current_session.session_id ~= nil
        and current_session.chat_history ~= nil
        and #current_session.chat_history.messages > 0
    if not has_conflict then
        on_restore()
        return
    end

    vim.ui.select({ "Cancel", "Clear current session and restore" }, {
        prompt = "Current session has messages. What would you like to do?",
        snacks = {
            preview = "none",
            layout = { preset = "select", preview = false },
        },
    }, function(choice)
        if choice == "Clear current session and restore" then
            on_restore()
        end
    end)
end

local function restore(current_session, item, lifecycle, valid)
    if not valid() then return end
    if lifecycle then
        local Logger = require("agentic.utils.logger")
        if item.unavailable then
            Logger.notify(item.unavailable_reason or "Backend unavailable: " .. tostring(item.backend_id), vim.log.levels.WARN)
            return
        end
        vim.ui.select({ "Cancel", "Restore" }, { prompt = "Restore saved session with a new provider process?" }, vim.schedule_wrap(function(choice)
            if choice ~= "Restore" or not valid() then return end
            lifecycle.restore(item.session_id:sub(8))
        end))
        return
    end
    with_conflict_check(current_session, function()
        current_session:load_acp_session(item.session_id, item.original_title, item.updated_at)
        current_session.widget:show()
    end)
end

local function agency_picker(current_session, lifecycle, valid)
    local List = require("sodium.agency.session_list")
    local base, picker, closed = "Select session to restore", nil, false
    picker = Snacks.picker({
        title = base, items = {}, show_empty = true, layout = { hidden = {} },
        format = List.format, preview = List.preview(lifecycle.excerpt),
        sort = { fields = { "score:desc", "epoch:desc", "idx" } },
        confirm = function(p, item)
            if not item or item.issue then return end
            p:close()
            restore(current_session, item, lifecycle, valid)
        end,
        on_close = function() closed = true end,
    })
    List.loading(picker, base, true)
    lifecycle.page({ allow_issues = true, alive = function() return not closed end }, function(err, result)
        if closed then return end
        if not valid() then List.loading(picker, base, false); return end
        local items = {}
        if err then
            local title = "Could not list sessions: " .. tostring(err.message or err.code)
            items[1] = { label = "local", title = title, text = "local · " .. title, status = "Issue", issue = err }
        else
            for _, view in ipairs(result.agents or {}) do
                local record = view.record
                if record.version == 3 and (record.phase == "stopped" or record.phase == "recoverable") then
                    local item = List.item(view, { status = record.phase == "stopped" and "Stopped" or "Needs recovery" })
                    local issue = view.unavailable ~= nil and view.unavailable ~= vim.NIL and view.unavailable or nil
                    item.session_id, item.backend_id = "agency:" .. record.definition.agentId, record.definition.backendId
                    item.unavailable, item.unavailable_reason = issue ~= nil, issue and issue.message or nil
                    if issue then item.preview[#item.preview + 1] = string.format("%-14s%s", "Unavailable:", tostring(issue.message)) end
                    items[#items + 1] = item
                end
            end
            for _, issue in ipairs(result.issues or {}) do
                local title = tostring(issue.message or issue.code or "Unavailable")
                items[#items + 1] = { label = "local", title = title, text = "local · " .. title, status = "Issue", issue = issue }
            end
        end
        picker.opts.items = List.order(items)
        List.loading(picker, base, false)
        picker:find({ refresh = true })
    end)
    return picker
end

function M.show_picker(current_session, deps)
    local cwd = vim.fn.getcwd()
    local config = require("agentic.config")
    local agency = config.acp_providers.agency ~= nil
        and current_session.agent.provider_config == config.acp_providers.agency
    local lifecycle = agency and (deps and deps.lifecycle or require("sodium.agency").setup())
    local valid = function() return true end
    if lifecycle and lifecycle.selection_guard then
        local guard, tab = lifecycle.selection_guard(current_session)
        valid = function() return guard() and vim.api.nvim_get_current_tabpage() == tab end
    end
    if agency then return agency_picker(current_session, lifecycle, valid) end
    current_session.agent:when_ready(function()
        if not valid() then return end
        local function show(result, err)
            if not valid() then return end
            local Logger = require("agentic.utils.logger")
            if err or not result then
                Logger.notify(
                    "Failed to list sessions: " .. (err and err.message or "unknown error"),
                    vim.log.levels.WARN
                )
                return
            end

            local items = M.normalize_sessions(result.sessions)
            if #items == 0 then
                Logger.notify("No saved sessions found", vim.log.levels.INFO)
                return
            end

            vim.schedule(function()
                if not valid() then return end
                Snacks.picker({
                    title = "Select session to restore",
                    items = items,
                    layout = { hidden = {} },
                    format = function(item)
                        return {
                            { item.display_title },
                            { "  " },
                            { item.directory, "SnacksPickerDir" },
                            { item.labels or "", "SnacksPickerComment" },
                            { "  " .. item.updated_at, "SnacksPickerComment" },
                        }
                    end,
                    preview = function(ctx)
                        ctx.preview:reset()
                        if not ctx.item then return end
                        ctx.preview:set_lines(M.preview_lines(ctx.item))
                    end,
                    confirm = function(picker, item)
                        if not item then
                            return
                        end
                        picker:close()
                        restore(current_session, item, lifecycle, valid)
                    end,
                })
            end)
        end
        current_session.agent:list_sessions(cwd, show)
    end)
end

return M