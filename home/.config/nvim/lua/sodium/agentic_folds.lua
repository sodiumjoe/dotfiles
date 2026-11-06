local M = {}
local pending_ns = vim.api.nvim_create_namespace("sodium_agentic_pending_thought_folds")
local thinking_ns = vim.api.nvim_create_namespace("agentic_thinking")

local function queue(writer, first, last)
    if require("agentic.ui.tool_call_fold").threshold() == nil or not vim.api.nvim_buf_is_valid(writer.bufnr) then return end
    if not first or not last or first > last or last >= vim.api.nvim_buf_line_count(writer.bufnr) then return end
    local text = vim.api.nvim_buf_get_lines(writer.bufnr, last, last + 1, false)[1]
    while last > first and text == "" do
        last = last - 1
        text = vim.api.nvim_buf_get_lines(writer.bufnr, last, last + 1, false)[1]
    end
    local id = vim.api.nvim_buf_set_extmark(writer.bufnr, pending_ns, first, 0, {
        end_row = last, end_col = #text, right_gravity = false, end_right_gravity = false,
    })
    writer._sodium_pending_thought_folds = writer._sodium_pending_thought_folds or {}
    table.insert(writer._sodium_pending_thought_folds, id)
end

local function fold_pending(writer)
    local pending = writer._sodium_pending_thought_folds
    if not pending then return end
    if not vim.api.nvim_buf_is_valid(writer.bufnr) then
        writer._sodium_pending_thought_folds = nil
        return
    end
    if #vim.fn.win_findbuf(writer.bufnr) == 0 then return end
    writer._sodium_pending_thought_folds = nil
    local Fold = require("agentic.ui.tool_call_fold")
    for _, id in ipairs(pending) do
        local mark = vim.api.nvim_buf_get_extmark_by_id(writer.bufnr, pending_ns, id, { details = true })
        if mark[3] and mark[3].end_row then
            Fold.close_range(writer.bufnr, mark[1] + 1, mark[3].end_row + 1)
        end
        vim.api.nvim_buf_del_extmark(writer.bufnr, pending_ns, id)
    end
end

function M.finish_thinking(writer)
    if not vim.api.nvim_buf_is_valid(writer.bufnr) or not writer._thinking_extmark_id then return end
    writer:_capture_scroll(writer.bufnr)
    writer:_clear_thinking_state()
    require("agentic.utils.buf_helpers").with_modifiable(writer.bufnr, function()
        writer:_append_lines({ "" })
    end)
    writer:_apply_scroll(writer.bufnr)
end

function M.install()
    local Writer = require("agentic.ui.message_writer")
    if Writer._sodium_thinking_folds then return end
    local clear, apply = Writer._clear_thinking_state, Writer._apply_scroll
    local set_mark, replay, reset = Writer._set_thinking_extmark, Writer.replay_history_messages, Writer.reset_sender_tracking

    function Writer:_clear_thinking_state()
        if self._thinking_extmark_id and not self._sodium_resetting_folds and vim.api.nvim_buf_is_valid(self.bufnr) then
            local mark = vim.api.nvim_buf_get_extmark_by_id(self.bufnr, thinking_ns, self._thinking_extmark_id, { details = true })
            if mark[3] then queue(self, mark[1], mark[3].end_row) end
        end
        return clear(self)
    end

    function Writer:_apply_scroll(bufnr)
        fold_pending(self)
        return apply(self, bufnr)
    end

    function Writer:_set_thinking_extmark(first, last, id)
        if id then
            local mark = vim.api.nvim_buf_get_extmark_by_id(self.bufnr, thinking_ns, id, {})
            if mark[1] then
                first = mark[1]
                self._thinking_start_line = first
            end
        end
        local result = set_mark(self, first, last, id)
        if self._sodium_replaying_thoughts then queue(self, first, last) end
        return result
    end

    function Writer:replay_history_messages(messages)
        local previous = self._sodium_replaying_thoughts
        self._sodium_replaying_thoughts = true
        local ok, result = xpcall(function() return replay(self, messages) end, debug.traceback)
        self._sodium_replaying_thoughts = previous
        if not ok then error(result) end
        self:_capture_scroll(self.bufnr)
        self:_apply_scroll(self.bufnr)
        return result
    end

    function Writer:reset_sender_tracking()
        self._sodium_resetting_folds = true
        reset(self)
        self._sodium_resetting_folds = nil
        self._sodium_pending_thought_folds = nil
        if vim.api.nvim_buf_is_valid(self.bufnr) then vim.api.nvim_buf_clear_namespace(self.bufnr, pending_ns, 0, -1) end
    end

    Writer._sodium_thinking_folds = true
end

return M