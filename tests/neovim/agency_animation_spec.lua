package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path

describe("Agency status animation", function()
    local f, animation, defer, get_lines, timers
    before_each(function()
        f = require("fixtures.agency_native").new()
        animation = f.manager.status_animation
        animation:stop()
        defer, get_lines, timers = vim.defer_fn, vim.api.nvim_buf_get_lines, {}
        vim.defer_fn = function(callback, delay)
            local handle = { callback = callback, delay = delay, active = true, closing = false }
            function handle:stop() self.active = false end
            function handle:close() self.closing = true; self.active = false end
            function handle:is_active() return self.active end
            function handle:is_closing() return self.closing end
            timers[#timers + 1] = handle
            return handle
        end
    end)
    after_each(function()
        animation:stop()
        vim.defer_fn, vim.api.nvim_buf_get_lines = defer, get_lines
        f.close()
    end)

    it("keeps the timer frame and mark on repeated unchanged starts", function()
        animation:start("generating")
        local handle, mark, index = animation._next_frame_handle, animation._extmark_id, animation._spinner_idx
        for _ = 1, 100 do animation:start("generating") end
        assert.are.equal(1, #timers)
        assert.are.equal(handle, animation._next_frame_handle)
        assert.are.equal(mark, animation._extmark_id)
        assert.are.equal(index, animation._spinner_idx)
        assert.are.equal(200, handle.delay)
    end)

    it("changes state and restarts after a permission stop", function()
        animation:start("generating")
        local old = animation._next_frame_handle
        animation:start("thinking")
        assert.is_true(old.closing)
        assert.are.equal("thinking", animation._state)
        assert.are.equal(600, animation._next_frame_handle.delay)
        animation:stop()
        assert.is_nil(animation._extmark_id)
        assert.is_nil(animation._next_frame_handle)
        animation:start("thinking")
        assert.are.equal(3, #timers)
        assert.are.equal(600, animation._next_frame_handle.delay)
    end)

    it("counts lines without copying chat history", function()
        vim.api.nvim_buf_get_lines = function(...) error("animation must not read buffer contents") end
        animation:start("busy")
        assert.are.equal(100, animation._next_frame_handle.delay)
        assert.is_number(animation._extmark_id)
    end)

    it("moves the existing mark to the latest buffer end on each frame", function()
        animation:start("generating")
        local mark = animation._extmark_id
        local buf = animation._bufnr
        vim.bo[buf].modifiable = true
        vim.api.nvim_buf_set_lines(buf, -1, -1, false, { "new", "output" })
        local timer = animation._next_frame_handle
        timer:close()
        timer.callback()
        local position = vim.api.nvim_buf_get_extmark_by_id(buf, vim.api.nvim_create_namespace("agentic_animation"), mark, { details = true })
        assert.are.equal(mark, animation._extmark_id)
        assert.are.equal(vim.api.nvim_buf_line_count(buf) - 1, position[1])
        assert.are.equal(3, #position[3].virt_lines)
        assert.is_truthy(position[3].virt_lines[2][2][1]:find("generating", 1, true))
        assert.are.equal(2, #timers)
    end)

    it("rejects an old scheduled frame after stop and restart", function()
        animation:start("generating")
        local old = animation._next_frame_handle
        old:close()
        animation:stop()
        animation:start("thinking")
        local current = animation._next_frame_handle
        old.callback()
        assert.are.equal(2, #timers)
        assert.are.equal(current, animation._next_frame_handle)
        assert.are.equal("thinking", animation._state)
    end)

    it("stops cleanly when its buffer disappears", function()
        animation:start("generating")
        local timer = animation._next_frame_handle
        vim.api.nvim_buf_delete(animation._bufnr, { force = true })
        timer:close()
        timer.callback()
        assert.are.equal(1, #timers)
        assert.is_nil(animation._next_frame_handle)
        assert.is_nil(animation._extmark_id)
        assert.is_nil(animation._state)
    end)

    it("leaves direct provider animations unchanged", function()
        local native = require("agentic.ui.status_animation"):new(vim.api.nvim_create_buf(false, true))
        native:start("generating")
        local old = native._next_frame_handle
        native:start("generating")
        assert.is_true(old.closing)
        assert.are.equal(2, #timers)
        native:stop()
        vim.api.nvim_buf_delete(native._bufnr, { force = true })
    end)
end)