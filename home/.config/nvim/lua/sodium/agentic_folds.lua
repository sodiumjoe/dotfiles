local Patch = require("sodium.patch")
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

function M.fold_completed_diff(writer, tool_call_id)
    local tracker = writer.tool_call_blocks[tool_call_id]
    if not tracker or not tracker.diff or tracker.status ~= "completed" or tracker.has_fold then return false end
    if not vim.api.nvim_buf_is_valid(writer.bufnr) then return false end
    local Blocks, Fold = require("agentic.ui.tool_call_blocks"), require("agentic.ui.tool_call_fold")
    local mark = vim.api.nvim_buf_get_extmark_by_id(writer.bufnr, Blocks.NS_TOOL_BLOCKS, tracker.extmark_id, { details = true })
    local last = mark[3] and mark[3].end_row
    if not last or not Fold.should_fold({ bufnr = writer.bufnr, start_row = mark[1] + Blocks.HEADER_HEIGHT,
        end_row = last - 2, status = tracker.status, is_diff = true }) then return false end
    writer:_capture_scroll(writer.bufnr)
    Fold.close_range(writer.bufnr, mark[1] + Blocks.HEADER_HEIGHT, last)
    tracker.has_fold = true
    writer:_apply_scroll(writer.bufnr)
    return true
end

function M.install()
    local Widget = require("agentic.ui.chat_widget")
    if Patch.claim(Widget, "folds", M) then
        local clear_widget = Patch.original(Widget, "clear")
        function Widget:clear()
            local result = clear_widget(self)
            local chat = self.buf_nrs and self.buf_nrs.chat
            if chat and vim.api.nvim_buf_is_valid(chat) then vim.api.nvim_buf_clear_namespace(chat, -1, 0, -1) end
            return result
        end
    end
    local Fold = require("agentic.ui.tool_call_fold")
    if Patch.claim(Fold, "folds", M) then
        local should_fold = Patch.original(Fold, "should_fold")
        function Fold.should_fold(opts)
            if opts.is_diff and opts.status == "completed" then
                opts = vim.tbl_extend("force", opts, { is_diff = false })
            end
            if Fold.threshold() == 0 and not opts.is_diff then
                if not Fold.should_auto_fold(opts.status) or not vim.api.nvim_buf_is_valid(opts.bufnr)
                    or opts.start_row < 0 or opts.start_row > opts.end_row
                    or opts.end_row >= vim.api.nvim_buf_line_count(opts.bufnr) then return false end
                for _, win in ipairs(vim.fn.win_findbuf(opts.bufnr)) do
                    if vim.api.nvim_win_is_valid(win) then return true end
                end
                return false
            end
            return should_fold(opts)
        end
    end
    local Writer = require("agentic.ui.message_writer")
    if not Patch.claim(Writer, "folds", M) then return end
    local update = Patch.original(Writer, "update_tool_call_block")
    function Writer:update_tool_call_block(block)
        local result = update(self, block)
        M.fold_completed_diff(self, block.tool_call_id)
        return result
    end
    local clear, apply = Patch.original(Writer, "_clear_thinking_state"), Patch.original(Writer, "_apply_scroll")
    local set_mark, replay, reset = Patch.original(Writer, "_set_thinking_extmark"), Patch.original(Writer, "replay_history_messages"), Patch.original(Writer, "reset_sender_tracking")

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

end

return M