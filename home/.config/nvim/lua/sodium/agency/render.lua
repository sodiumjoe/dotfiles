local M = {}
local defaults = { text_bytes = 4194304, lines = 20000, tool_count = 512, tool_string_bytes = 4194304 }
local helpers = require("agentic.utils.buf_helpers")
local Writer = require("agentic.ui.message_writer")
local Animation = require("agentic.ui.status_animation")

local function present(value)
    return value ~= nil and value ~= vim.NIL
end

local function strings(value)
    if type(value) == "string" then
        return #value
    end
    local bytes = 0
    if type(value) == "table" then
        for key, child in pairs(value) do
            bytes = bytes + (type(key) == "string" and #key or 0) + strings(child)
        end
    end
    return bytes
end

local function path(cwd, name)
    if not name or name == "" then
        return nil
    end
    return vim.fs.normalize(name:sub(1, 1) == "/" and name or cwd .. "/" .. name)
end

local function block(update, cwd, partial)
    local result = { tool_call_id = update.toolCallId }
    for source, target in pairs({ title = "argument", status = "status", kind = "kind" }) do
        if present(update[source]) then
            result[target] = update[source]
        end
    end
    local body = {}
    if present(update.locations) then
        result.locations = vim.deepcopy(update.locations)
        for _, location in ipairs(result.locations) do
            location.path = path(cwd, location.path)
            body[#body + 1] = location.path .. (present(location.line) and ":" .. location.line or "")
            result.file_path = result.file_path or location.path
        end
    end
    if present(update.content) then
        for _, item in ipairs(update.content) do
            if item.type == "content" then
                vim.list_extend(body, vim.split(item.content.text, "\n", { plain = true }))
            elseif item.type == "diff" then
                result.file_path = path(cwd, item.path)
                result.diff = {
                    old = vim.split(present(item.oldText) and item.oldText or "", "\n", { plain = true }),
                    new = vim.split(item.newText, "\n", { plain = true }),
                }
            elseif item.type == "terminal" then
                body[#body + 1] = "Terminal result: " .. item.terminalId
            end
        end
    end
    for _, key in ipairs({ "rawInput", "rawOutput" }) do
        if present(update[key]) then
            local raw = update[key]
            body[#body + 1] = key .. ": " .. vim.json.encode(raw)
            if type(raw) == "table" then
                result.file_path = result.file_path or path(cwd, raw.file_path or raw.filePath)
            end
        end
    end
    if #body > 0 then
        result.body = body
    end
    if partial then
        result.argument = "[partial tool] " .. (result.argument or update.toolCallId)
    end
    return result
end

function M.new(widget, metadata, limits)
    limits = vim.tbl_extend("force", defaults, limits or {})
    local api = { renderFirstSeq = nil, lastSeq = 0 }
    local animation = Animation:new(widget.buf_nrs.chat)
    local released, destroyed, rebuilding = true, false, false
    local function clear(name)
        local buf = widget.buf_nrs[name]
        if vim.api.nvim_buf_is_valid(buf) then
            vim.api.nvim_buf_clear_namespace(buf, -1, 0, -1)
            helpers.with_modifiable(buf, function()
                vim.api.nvim_buf_set_lines(buf, 0, -1, false, {})
            end)
        end
    end
    function api.metrics()
        local result = { text_bytes = 0, lines = 0, tool_count = 0, tool_string_bytes = 0 }
        if released or not vim.api.nvim_buf_is_valid(widget.buf_nrs.chat) then
            return result
        end
        local lines = vim.api.nvim_buf_get_lines(widget.buf_nrs.chat, 0, -1, false)
        result.lines = #lines
        for _, line in ipairs(lines) do
            result.text_bytes = result.text_bytes + #line + 1
        end
        if #lines == 1 and lines[1] == "" then
            result.lines, result.text_bytes = 0, 0
        end
        for id, tracker in pairs(api.writer.tool_call_blocks) do
            result.tool_count = result.tool_count + 1
            result.tool_string_bytes = result.tool_string_bytes + #id + strings(tracker)
        end
        return result
    end
    local function over()
        local counts = api.metrics()
        for key, value in pairs(counts) do
            if value > limits[key] then
                return true
            end
        end
        return false
    end
    function api.release()
        animation:stop()
        if api.writer then
            api.writer:destroy()
        end
        api.writer = nil
        clear("chat")
        clear("todos")
        released = true
        api.renderFirstSeq, api.lastSeq = nil, 0
    end
    local function initialize(snapshot, truncated)
        api.release()
        released = false
        api.writer = Writer:new(widget.buf_nrs.chat)
        api.writer:set_provider_name("Agency " .. snapshot.selection.modelId)
        api.writer._is_restoring = true
        api.lastSeq = snapshot.firstSeq - 1
        if truncated then
            helpers.with_modifiable(widget.buf_nrs.chat, function(buf)
                vim.api.nvim_buf_set_lines(buf, 0, -1, false, { "[Agency history truncated]" })
            end)
        end
    end
    local function plan(entries)
        local lines = {}
        for _, entry in ipairs(entries or {}) do
            vim.list_extend(lines, vim.split("[" .. entry.status .. "] " .. entry.content, "\n", { plain = true }))
        end
        helpers.with_modifiable(widget.buf_nrs.todos, function(buf)
            vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
        end)
        widget.render_header("todos", tostring(#(entries or {})) .. " entries")
    end
    local function write(event, replay, snapshot)
        local writer = api.writer
        writer._is_restoring = replay
        if event.kind == "submitted" then
            writer:write_message({
                sessionUpdate = "user_message_chunk",
                content = { type = "text", text = event.text },
            })
        elseif event.kind == "turn" then
            if event.state ~= "accepted" and event.state ~= "running" then
                writer:write_message({
                    sessionUpdate = "agent_message_chunk",
                    content = {
                        type = "text",
                        text = "\n[Turn "
                            .. event.state
                            .. (present(event.stopReason) and ": " .. event.stopReason or "")
                            .. "]",
                    },
                })
                writer:reset_sender_tracking()
            end
        elseif event.kind == "update" then
            local update = event.update
            local kind = update.sessionUpdate
            if kind == "agent_message_chunk" or kind == "agent_thought_chunk" or kind == "user_message_chunk" then
                writer:write_message_chunk(update)
            elseif kind == "tool_call" or kind == "tool_call_update" then
                local prior = writer.tool_call_blocks[update.toolCallId]
                local normalized = block(update, snapshot.cwd, kind == "tool_call_update" and not prior)
                if prior then
                    writer:update_tool_call_block(normalized)
                else
                    writer:write_tool_call_block(normalized)
                end
            elseif kind == "plan" then
                plan(update.entries)
            end
        end
        api.renderFirstSeq = api.renderFirstSeq or event.seq
        api.lastSeq = event.seq
    end
    local function summarize(event)
        local tool = event.update and event.update.toolCallId
        local summary = "[Agency event "
            .. event.seq
            .. " "
            .. (event.update and event.update.sessionUpdate or event.kind)
            .. (tool and " tool " .. tool or "")
            .. " omitted: view limit]"
        local available = math.max(0, limits.text_bytes - api.metrics().text_bytes - 2)
        if #summary > available then
            summary = summary:sub(1, available)
        end
        helpers.with_modifiable(widget.buf_nrs.chat, function(buf)
            if api.metrics().lines < limits.lines then
                vim.api.nvim_buf_set_lines(buf, -1, -1, false, { summary })
            end
        end)
        api.renderFirstSeq = api.renderFirstSeq or event.seq
        api.lastSeq = event.seq
    end
    function api.compact(snapshot)
        if destroyed then
            return
        end
        snapshot = snapshot or metadata()
        if not snapshot then
            api.release()
            return
        end
        rebuilding = true
        local events, start, bytes = snapshot.events, #snapshot.events + 1, 0
        for i = #events, 1, -1 do
            local size = math.max(events[i].encodedBytes or 0, #vim.json.encode(events[i]))
            if #events - i >= 1024 or bytes + size > 1048576 then
                break
            end
            start, bytes = i, bytes + size
        end
        if #events > 0 and start > #events then
            start = #events
        end
        while true do
            initialize(snapshot, snapshot.historyTruncated or start > 1)
            local excess = false
            for i = start, #events do
                write(events[i], true, snapshot)
                if over() then
                    excess = true
                    break
                end
            end
            if not excess then
                break
            end
            if start < #events then
                start = start + math.max(1, math.floor((#events - start) / 2))
            else
                initialize(snapshot, true)
                summarize(events[start])
                break
            end
        end
        plan(snapshot.metadata and snapshot.metadata.plan or {})
        api.lastSeq = snapshot.lastSeq
        api.renderFirstSeq = api.renderFirstSeq or snapshot.lastSeq + 1
        rebuilding = false
    end
    function api.reset(snapshot)
        api.compact(snapshot)
    end
    function api.event(event, options)
        if released or destroyed then
            if destroyed then
                return
            end
            initialize(metadata(), false)
        end
        local snapshot = metadata()
        if not snapshot or not vim.api.nvim_buf_is_valid(widget.buf_nrs.chat) then
            return
        end
        write(event, options and options.replay or event.replay == true, snapshot)
        if over() and not rebuilding then
            api.compact(snapshot)
        end
    end
    function api.animate(busy)
        if busy and not released then
            animation:start("generating")
        else
            animation:stop()
        end
    end
    function api.destroy()
        if destroyed then
            return
        end
        api.release()
        destroyed = true
    end
    return api
end

return M