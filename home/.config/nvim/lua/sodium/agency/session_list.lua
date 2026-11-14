local M = {}
local labels = { ["codex-acp"] = "Codex", ["claude-agent-acp"] = "Claude" }

function M.epoch(timestamp)
    if type(timestamp) ~= "string" then return nil end
    local y, mo, d, h, mi, s = timestamp:match("^(%d%d%d%d)-(%d%d)-(%d%d)T(%d%d):(%d%d):(%d%d)")
    if not y then return nil end
    local offset = os.time() - os.time(os.date("!*t"))
    return os.time({ year = tonumber(y), month = tonumber(mo), day = tonumber(d), hour = tonumber(h), min = tonumber(mi), sec = tonumber(s), isdst = false }) + offset
end

function M.age(timestamp, now)
    local epoch = M.epoch(timestamp)
    if not epoch then return "" end
    local seconds = math.max(0, (now or os.time()) - epoch)
    if seconds < 60 then return "now" end
    if seconds < 3600 then return math.floor(seconds / 60) .. "m" end
    if seconds < 86400 then return math.floor(seconds / 3600) .. "h" end
    return math.floor(seconds / 86400) .. "d"
end

function M.model(record)
    local settings = type(record.settings) == "table" and record.settings or {}
    local values = type(settings.configValues) == "table" and settings.configValues or {}
    local model = values.model or settings.modelId
    local backend = labels[record.definition.backendId] or record.definition.backendId
    return type(model) == "string" and model ~= "" and backend .. " · " .. model or backend
end

function M.clip(value, width)
    if width <= 0 then return "" end
    if vim.fn.strdisplaywidth(value) <= width then return value end
    local text = vim.fn.strcharpart(value, 0, width - 1)
    while vim.fn.strdisplaywidth(text) > width - 1 do text = vim.fn.strcharpart(text, 0, vim.fn.strchars(text) - 1) end
    return text .. "…"
end

function M.column(value, width)
    local text = M.clip(value, width)
    return text .. string.rep(" ", math.max(0, width - vim.fn.strdisplaywidth(text)))
end

function M.item(view, fields)
    local record = view.record
    local display = type(view.display) == "table" and view.display or {}
    local raw = type(display.title) == "string" and display.title or type(record.title) == "string" and record.title or nil
    local title, metadata = require("sodium.agentic_sessions").parse_title(raw, true)
    title = vim.trim(title:gsub("%c", " "):gsub("%s+", " "))
    if title == "" then title = "New conversation" end
    local at = type(record.lastActivityAt) == "string" and record.lastActivityAt or nil
    local item = { id = fields.id or record.definition.agentId, view = vim.deepcopy(view), title = title, label = fields.label or "local",
        model = M.model(record), age = M.age(at), epoch = M.epoch(at), status = fields.status,
        excerpt = { agentId = record.definition.agentId, key = record.definition.agentId .. "@" .. tostring(at) } }
    local preview = { title, "" }
    for _, field in ipairs({ { "Directory:", record.definition.cwd }, { "Model:", item.model }, { "Status:", fields.status_detail or fields.status },
        { "Last active:", item.age ~= "" and (item.age == "now" and "just now" or item.age .. " ago") or nil }, { "Session ID:", record.definition.agentId },
        { "Project root:", metadata.project_root }, { "Branch:", metadata.branch }, { "Plan:", metadata.plan } }) do
        if type(field[2]) == "string" and field[2] ~= "" then preview[#preview + 1] = string.format("%-14s%s", field[1], field[2]) end
    end
    item.preview = preview
    item.text = table.concat({ item.label, title, item.model, record.definition.cwd, fields.status or "" }, " · ")
    return item
end

function M.order(items)
    for index, item in ipairs(items) do item._order = index end
    table.sort(items, function(a, b)
        if (a.issue ~= nil) ~= (b.issue ~= nil) then return b.issue ~= nil end
        if a.epoch and b.epoch and a.epoch ~= b.epoch then return a.epoch > b.epoch end
        if (a.epoch ~= nil) ~= (b.epoch ~= nil) then return a.epoch ~= nil end
        return a._order < b._order
    end)
    return items
end

function M.format(item, picker)
    return { { "", resolve = function(width)
        width = math.max(1, width - 1)
        if width < 20 then return { { M.clip("[" .. (item.label or "") .. "] " .. (item.title or ""), width) } } end
        local label_width = math.min(picker and picker._agency_label_width or 9, 32, math.floor(width / 4))
        local status_width = math.min(14, math.floor(width / 5))
        local model_width = width >= 70 and math.min(22, math.floor(width / 4)) or 0
        local title_width = math.max(1, width - label_width - model_width - 4 - status_width - (model_width > 0 and 7 or 5))
        local chunks = { { M.column("[" .. M.clip(item.label or "", label_width - 2) .. "]", label_width), "Identifier" }, { "  " }, { M.column(item.title or "", title_width) } }
        if model_width > 0 then vim.list_extend(chunks, { { "  " }, { M.column(item.model or "", model_width), "SnacksPickerComment" } }) end
        local status_hl = item.issue and "DiagnosticWarn" or item.status == "Working" and "DiagnosticInfo" or "Comment"
        local status = M.clip(item.status or "", status_width)
        local badge = status ~= "" and " " .. status .. (vim.fn.strdisplaywidth(status) < status_width and " " or "") or " "
        vim.list_extend(chunks, { { "  " }, { M.column(item.age or "", 4), "SnacksPickerComment" }, { badge, status ~= "" and status_hl or nil }, { string.rep(" ", math.max(0, status_width + 1 - vim.fn.strdisplaywidth(badge))) } })
        return chunks
    end } }
end

local function reason(err, excerpt)
    if excerpt.hostId and vim.tbl_contains({ "STALE_HANDLER", "INVALID_PROTOCOL", "UNSUPPORTED_CAPABILITY" }, err.code) then return "Excerpt unavailable: update this devbox" end
    if not excerpt.hostId and err.code == "INVALID_PROTOCOL" then return "Excerpt unavailable: restart the Agency Handler" end
    return "Excerpt unavailable: " .. tostring(err.message or err.code)
end

function M.preview(load)
    local cache = {}
    return function(ctx)
        ctx.preview:reset()
        local item = ctx.item
        if not item then return end
        local lines = vim.deepcopy(item.preview or vim.split(vim.inspect(item.issue), "\n"))
        local excerpt = item.excerpt
        if excerpt and load then
            vim.list_extend(lines, { "", "Recent conversation" })
            if not cache[excerpt.key] then
                cache[excerpt.key] = { loading = true }
                local picker = ctx.picker
                load(excerpt, vim.schedule_wrap(function(err, result)
                    cache[excerpt.key] = err and { reason = reason(err, excerpt) } or result or { reason = "Excerpt unavailable" }
                    local current = picker and not picker.closed and picker:current()
                    if current and current.excerpt and current.excerpt.key == excerpt.key then picker.preview:show(picker, { force = true }) end
                end))
            end
            local cached = cache[excerpt.key]
            if cached.loading then lines[#lines + 1] = "Loading conversation…"
            elseif cached.reason and cached.reason ~= vim.NIL and #(cached.turns or {}) == 0 then lines[#lines + 1] = cached.reason
            elseif #(cached.turns or {}) == 0 then lines[#lines + 1] = "No conversation yet"
            else
                for _, turn in ipairs(cached.turns) do
                    lines[#lines + 1] = ""
                    lines[#lines + 1] = (turn.role == "user" and "› you: " or "‹ agent: ") .. turn.text
                end
            end
        end
        ctx.preview:set_lines(lines)
    end
end

function M.loading(picker, base, pending)
    if not picker or picker.closed then return end
    picker.title = base .. (pending and " (loading…)" or "")
    picker:update_titles()
end

return M