describe("agentic resize", function()
    local function find_resize_callback()
        local ok, spec = pcall(require, "sodium.plugins.agentic")
        if not ok then return nil end
        for _, key in ipairs(spec.keys or {}) do
            if type(key) == "table" and key[1] == "<leader>a=" then
                return key[2]
            end
        end
        return nil
    end

    local resize_fn = find_resize_callback()

    if not resize_fn then return end

    it("resizes agentic window when undersized", function()
        vim.cmd("botright split")
        local win = vim.api.nvim_get_current_win()
        local buf = vim.api.nvim_create_buf(false, true)
        vim.api.nvim_win_set_buf(win, buf)
        vim.bo[buf].filetype = "AgenticChat"
        vim.api.nvim_win_set_height(win, 1)
        local before = vim.api.nvim_win_get_height(win)

        resize_fn()

        local after = vim.api.nvim_win_get_height(win)
        assert.is_true(after > before, "window should grow from minimum height")

        vim.api.nvim_win_close(win, true)
        vim.api.nvim_buf_delete(buf, { force = true })
    end)

    it("does nothing when no agentic window is visible", function()
        assert.are.equal(1, #vim.api.nvim_list_wins())
        local win = vim.api.nvim_get_current_win()
        local height_before = vim.api.nvim_win_get_height(win)
        resize_fn()
        assert.are.equal(height_before, vim.api.nvim_win_get_height(win))
    end)

    it("targets 50% of vim.o.lines", function()
        vim.cmd("botright split")
        local win = vim.api.nvim_get_current_win()
        local buf = vim.api.nvim_create_buf(false, true)
        vim.api.nvim_win_set_buf(win, buf)
        vim.bo[buf].filetype = "AgenticChat"

        resize_fn()

        local expected = math.floor(vim.o.lines * 0.5)
        local actual = vim.api.nvim_win_get_height(win)
        assert.are.equal(expected, actual)

        vim.api.nvim_win_close(win, true)
        vim.api.nvim_buf_delete(buf, { force = true })
    end)

    for _, ft in ipairs({ "AgenticChat", "AgenticInput", "AgenticCode", "AgenticFiles", "AgenticTodos" }) do
        it("recognizes " .. ft, function()
            vim.cmd("botright split")
            local win = vim.api.nvim_get_current_win()
            local buf = vim.api.nvim_create_buf(false, true)
            vim.api.nvim_win_set_buf(win, buf)
            vim.bo[buf].filetype = ft
            vim.api.nvim_win_set_height(win, 1)
            local before = vim.api.nvim_win_get_height(win)

            resize_fn()

            local after = vim.api.nvim_win_get_height(win)
            assert.is_true(after > before, ft .. " should be resized")

            vim.api.nvim_win_close(win, true)
            vim.api.nvim_buf_delete(buf, { force = true })
        end)
    end
end)