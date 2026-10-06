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

local function parse_title(raw_title)
    local raw = type(raw_title) == "string" and raw_title or ""
    local metadata = {}
    local environment = raw:match("<environment_info>%s*(.-)%s*</environment_info>")

    if environment then
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
    title = vim.trim(title)
    if title == "" then
        title = "(no title)"
    end

    return title, metadata
end

function M.normalize_session(session)
    local title, metadata = parse_title(session.title)
    local updated_at = type(session.updatedAt) == "string"
            and session.updatedAt:sub(1, 16):gsub("T", " ")
        or "unknown date"

    local agency = session._meta and session._meta.agency or {}
    local backend = session.backendId or agency.backendId
    return {
        session_id = session.sessionId or session.nativeSessionId,
        native_session_id = session.nativeSessionId,
        backend_id = backend,
        cwd = session.cwd,
        phase = agency.phase,
        unavailable = backend ~= nil and backend ~= "codex-acp",
        original_title = session.title,
        title = title,
        updated_at = updated_at,
        sort_key = session_updated_at_sort_key(session.updatedAt),
        metadata = metadata,
        text = updated_at .. " " .. title,
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
            if field[2] then
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

local function restore(current_session, item, control)
    if control then
        local Logger = require("agentic.utils.logger")
        if item.unavailable then
            Logger.notify("Backend unavailable: " .. tostring(item.backend_id), vim.log.levels.WARN)
            return
        end
        local function load(session_id)
            current_session._agency_load_cwd = item.cwd
            current_session:load_acp_session(session_id, item.original_title, item.updated_at)
            current_session.widget:show()
        end
        if not item.native_session_id and item.phase == "ready" then
            with_conflict_check(current_session, function() load(item.session_id) end)
            return
        end
        vim.ui.select({ "Cancel", "Restore" }, { prompt = "Restore saved session with a new provider process?" }, function(choice)
            if choice ~= "Restore" then return end
            local function launch(session_id)
                control.command({ "agent", "restore", session_id:sub(8), "--command-id", control.uuid() },
                    { cwd = item.cwd, timeout_ms = 45000 }, function(err, reply)
                        local result = reply and reply.result
                        if err or not result or result.durability ~= "verified" or not result.command.result
                            or result.command.result == vim.NIL or result.command.result.outcome ~= "restored" then
                            Logger.notify("Restore failed: " .. (err and err.message or "incomplete"), vim.log.levels.WARN)
                            return
                        end
                        with_conflict_check(current_session, function() load(session_id) end)
                    end)
            end
            if not item.native_session_id then launch(item.session_id); return end
            item.import_command_id = item.import_command_id or control.uuid()
            current_session.agent:_send_request("agency/import", { commandId = item.import_command_id,
                backendId = item.backend_id, nativeSessionId = item.native_session_id, cwd = item.cwd }, function(reply, err)
                    if err or not reply then
                        Logger.notify("Import failed: " .. (err and err.message or "unknown error"), vim.log.levels.WARN)
                    else launch(reply.sessionId) end
                end)
        end)
        return
    end
    with_conflict_check(current_session, function()
        current_session:load_acp_session(item.session_id, item.original_title, item.updated_at)
        current_session.widget:show()
    end)
end

function M.show_picker(current_session, deps)
    local cwd = vim.fn.getcwd()
    local config = require("agentic.config")
    local agency = config.acp_providers.agency ~= nil
        and current_session.agent.provider_config == config.acp_providers.agency
    local control = agency and (deps and deps.control or require("sodium.agency.control"))
    current_session.agent:when_ready(function()
        local function show(result, err)
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
                Snacks.picker({
                    title = "Select session to restore",
                    items = items,
                    format = function(item)
                        return {
                            { item.updated_at, "SnacksPickerComment" },
                            { "  " },
                            { item.title },
                        }
                    end,
                    preview = function(ctx)
                        ctx.preview:reset()
                        ctx.preview:set_lines(M.preview_lines(ctx.item))
                    end,
                    confirm = function(picker, item)
                        if not item then
                            return
                        end
                        picker:close()
                        restore(current_session, item, control)
                    end,
                })
            end)
        end
        if not agency then current_session.agent:list_sessions(cwd, show); return end
        local known = {}
        local function list(cursor)
            current_session.agent:_send_request("session/list", cursor and { cursor = cursor } or {}, function(result, err)
                if err or not result then show(nil, err); return end
                vim.list_extend(known, result.sessions or {})
                if result.nextCursor then list(result.nextCursor); return end
                current_session.agent:_send_request("agency/native_sessions", {}, function(native, native_err)
                    if native_err and #known == 0 then show(nil, native_err); return end
                    local seen = {}
                    for _, session in ipairs(known) do
                        local identity = session._meta and session._meta.agency
                        if identity and type(identity.nativeSessionId) == "string" then seen[identity.backendId .. ":" .. identity.nativeSessionId] = true end
                    end
                    for _, session in ipairs(native and native.sessions or {}) do
                        if not seen[session.backendId .. ":" .. session.nativeSessionId] then known[#known + 1] = session end
                    end
                    show({ sessions = known })
                end)
            end)
        end
        list()
    end)
end

return M