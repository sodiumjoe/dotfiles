local M = {}

function M.discard(manager)
    local pending = manager._agency_stream
    manager._agency_stream = nil
    if pending and pending.timer then
        pcall(pending.timer.stop, pending.timer)
        if not pending.timer:is_closing() then pending.timer:close() end
    end
    return pending
end

function M.flush(manager, pending)
    pending = pending or M.discard(manager)
    if not pending or manager._destroyed or pending.client.subscribers[pending.session_id] ~= manager.handlers
        or manager.message_writer ~= pending.writer or not vim.api.nvim_buf_is_valid(pending.writer.bufnr) then return end
    pending.update.content.text = table.concat(pending.fragments)
    pending.write(pending.writer, pending.update)
end

local function enqueue(manager, client, session_id, writer, write, update)
    local key = vim.tbl_extend("force", update, { content = false })
    local pending = manager._agency_stream
    if pending and (not vim.deep_equal(pending.key, key) or pending.bytes + #update.content.text > 32768) then
        M.flush(manager)
        pending = nil
    end
    if not pending then
        pending = { writer = writer, write = write, client = client, session_id = session_id,
            update = vim.deepcopy(update), key = vim.deepcopy(key), fragments = {}, bytes = 0 }
        manager._agency_stream = pending
        pending.timer = vim.defer_fn(function()
            if manager._agency_stream == pending then M.flush(manager) end
        end, 16)
    end
    pending.fragments[#pending.fragments + 1] = update.content.text
    pending.bytes = pending.bytes + #update.content.text
    if pending.bytes >= 32768 then M.flush(manager) end
end

function M.mergeable(update)
    local content = update.content
    return (update.sessionUpdate == "agent_message_chunk" or update.sessionUpdate == "agent_thought_chunk")
        and type(content) == "table" and content.type == "text" and type(content.text) == "string"
        and content.text ~= "" and vim.tbl_count(content) == 2
end

function M.update(manager, client, session_id, update, deliver)
    if not M.mergeable(update) then
        M.flush(manager)
        return deliver()
    end
    local writer = manager.message_writer
    local own, write = rawget(writer, "write_message_chunk"), writer.write_message_chunk
    writer.write_message_chunk = function(self, value) enqueue(manager, client, session_id, self, write, value) end
    local ok, result = xpcall(deliver, debug.traceback)
    writer.write_message_chunk = own
    if not ok then error(result) end
    return result
end

return M