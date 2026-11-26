local M = { LIMIT = 10000, TARGET = 7500 }
local NS = vim.api.nvim_create_namespace("agency_trim_headers")

function M.hidden(bufnr)
    return vim.b[bufnr].agency_hidden_turns or 0
end

function M.marker_row(bufnr)
    return M.hidden(bufnr) > 0 and 0 or nil
end

local function marker(count)
    return string.format("󰁝 %d earlier turns hidden · <CR> to read them", count)
end

function M.attach(manager)
    local writer = manager.message_writer
    if manager._agency_trimmed == writer then
        return
    end
    manager._agency_trimmed = writer
    local native = writer._maybe_write_sender_header
    writer._maybe_write_sender_header = function(self, kind)
        local written = native(self, kind)
        if written and self._last_sender == "user" and vim.api.nvim_buf_is_valid(self.bufnr) then
            vim.api.nvim_buf_set_extmark(
                self.bufnr,
                NS,
                vim.api.nvim_buf_line_count(self.bufnr) - 2,
                0,
                { right_gravity = false }
            )
        end
        return written
    end
end

local function drop_state(writer, cut)
    for id in pairs(writer.tool_call_blocks) do
        local row = writer:_get_block_start_row(id)
        if row and row < cut then
            writer.tool_call_blocks[id] = nil
        end
    end
    vim.api.nvim_buf_clear_namespace(writer.bufnr, -1, 0, cut)
end

function M.trim(manager)
    local writer = manager.message_writer
    local bufnr = writer and writer.bufnr
    if not bufnr or not vim.api.nvim_buf_is_valid(bufnr) then
        return 0
    end
    local n = vim.api.nvim_buf_line_count(bufnr)
    if n <= M.LIMIT then
        return 0
    end
    local headers = {}
    for _, mark in ipairs(vim.api.nvim_buf_get_extmarks(bufnr, NS, 0, -1, {})) do
        if mark[2] > 0 then
            headers[#headers + 1] = mark[2]
        end
    end
    if #headers == 0 or n - headers[#headers] > M.LIMIT then
        return 0
    end
    local cut = headers[#headers]
    for _, row in ipairs(headers) do
        if 1 + n - row < M.TARGET then
            cut = row
            break
        end
    end
    local removed = 0
    for _, row in ipairs(headers) do
        if row < cut then
            removed = removed + 1
        end
    end
    if removed == 0 then
        return 0
    end
    local last = manager._agency_last_message
    local current = last and last.tick == vim.api.nvim_buf_get_changedtick(bufnr)
    local windows = {}
    for _, win in ipairs(vim.fn.win_findbuf(bufnr)) do
        if vim.api.nvim_win_get_cursor(win)[1] <= cut then
            windows[#windows + 1] = win
        end
    end
    drop_state(writer, cut)
    local hidden = M.hidden(bufnr) + removed
    local edited = require("agentic.utils.buf_helpers").with_modifiable(bufnr, function()
        local levels = vim.bo[bufnr].undolevels
        vim.bo[bufnr].undolevels = -1
        vim.api.nvim_buf_set_lines(bufnr, 0, cut - 1, false, {})
        vim.api.nvim_buf_set_text(
            bufnr,
            0,
            0,
            0,
            #vim.api.nvim_buf_get_lines(bufnr, 0, 1, false)[1],
            { marker(hidden) }
        )
        vim.bo[bufnr].undolevels = levels
        return true
    end)
    if not edited then
        return 0
    end
    vim.b[bufnr].agency_hidden_turns = hidden
    for _, win in ipairs(windows) do
        vim.api.nvim_win_set_cursor(win, { 1, 0 })
    end
    if current then
        last.tick = vim.api.nvim_buf_get_changedtick(bufnr)
    end
    return removed
end

return M