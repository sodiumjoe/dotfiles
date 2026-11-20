local M = {}

local metadata_keys = {
    ["Project root"] = "project_root",
    ["Current branch"] = "branch",
    Platform = "platform",
    Editor = "editor",
    Shell = "shell",
}

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

local function restore(item, lifecycle, valid)
    if not valid() then return end
    vim.ui.select({ "Cancel", "Restore" }, { prompt = "Restore saved session with a new provider process?" }, vim.schedule_wrap(function(choice)
        if choice ~= "Restore" or not valid() then return end
        lifecycle.restore(item.session_id:sub(8))
    end))
end

local function agency_picker(lifecycle, valid)
    local List = require("sodium.agency.session_list")
    local base, picker, closed = "Select session to restore", nil, false
    picker = Snacks.picker({
        title = base, items = {}, show_empty = true, layout = { hidden = {} },
        format = List.format, preview = List.preview(lifecycle.excerpt),
        sort = { fields = { "score:desc", "epoch:desc", "idx" } },
        confirm = function(p, item)
            if not item or item.issue then return end
            p:close()
            restore(item, lifecycle, valid)
        end,
        on_close = function() closed = true end,
    })
    List.loading(picker, base, true)
    lifecycle.page({ alive = function() return not closed end }, function(err, result)
        if closed then return end
        if not valid() then List.loading(picker, base, false); return end
        local items = {}
        if err then
            local title = "Could not list sessions: " .. tostring(err.message or err.code)
            items[1] = { label = "local", title = title, text = "local · " .. title, status = "Issue", issue = err }
        else
            for _, view in ipairs(result.agents or {}) do
                local record = view.record
                if record.phase == "stopped" then
                    local item = List.item(view, { status = "Stopped" })
                    item.session_id = "agency:" .. record.definition.agentId
                    items[#items + 1] = item
                end
            end
        end
        picker.opts.items = List.order(items)
        List.loading(picker, base, false)
        picker:find({ refresh = true })
    end)
    return picker
end

function M.show_picker(current_session, deps)
    local lifecycle = deps and deps.lifecycle or require("sodium.agency").setup()
    local valid = function() return true end
    if lifecycle.selection_guard then
        valid = lifecycle.selection_guard(current_session)
    end
    return agency_picker(lifecycle, valid)
end

return M