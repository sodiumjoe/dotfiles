local M = {}
local namespace = vim.api.nvim_create_namespace("agentic_animation")
local timing = { generating = 200, thinking = 600, searching = 600, busy = 100 }

function M.attach(animation)
    local stop = animation.stop
    function animation:stop()
        self._agency_frame_generation = (self._agency_frame_generation or 0) + 1
        return stop(self)
    end
    function animation:start(state)
        local handle = self._next_frame_handle
        if self._state == state and handle and not handle:is_closing() and handle:is_active() then return end
        self:stop()
        self._state, self._spinner_idx = state, 1
        self:_render_frame()
    end
    function animation:_render_frame()
        if not self._state or not vim.api.nvim_buf_is_valid(self._bufnr) then self:stop(); return end
        local config, theme = require("agentic.config"), require("agentic.theme")
        local chars = config.spinner_chars[self._state] or config.spinner_chars.generating
        local char = chars[self._spinner_idx] or chars[1]
        self._spinner_idx = self._spinner_idx % #chars + 1
        local text = string.format(" %s %s ", char, self._state)
        local virtual = { { text, theme.get_spinner_hl_group(self._state) } }
        local window = vim.fn.bufwinid(self._bufnr)
        if window ~= -1 and vim.api.nvim_win_is_valid(window) then
            local width, text_width = vim.api.nvim_win_get_width(window), vim.fn.strdisplaywidth(text)
            if width > text_width then table.insert(virtual, 1, { string.rep(" ", math.floor((width - text_width) / 2)), "Normal" }) end
        end
        self._extmark_id = vim.api.nvim_buf_set_extmark(self._bufnr, namespace,
            math.max(0, vim.api.nvim_buf_line_count(self._bufnr) - 1), 0, {
                id = self._extmark_id, virt_lines = { { { "" } }, virtual, { { "" } } }, virt_lines_above = false,
            })
        local generation, handle = self._agency_frame_generation, nil
        handle = vim.defer_fn(function()
            if self._agency_frame_generation ~= generation or self._next_frame_handle ~= handle then return end
            self._next_frame_handle = nil
            self:_render_frame()
        end, timing[self._state] or timing.generating)
        self._next_frame_handle = handle
    end
end

return M