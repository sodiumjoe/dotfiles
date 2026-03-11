require("sodium.plugins.markdown")

describe("markdown list continuation", function()
    local buf

    before_each(function()
        buf = vim.api.nvim_create_buf(false, true)
        vim.api.nvim_set_current_buf(buf)
        vim.bo[buf].filetype = "markdown"
    end)

    after_each(function()
        vim.api.nvim_buf_delete(buf, { force = true })
    end)

    describe("o (open line below)", function()
        it("continues bullet list", function()
            vim.api.nvim_buf_set_lines(buf, 0, -1, false, { "- item one" })
            vim.api.nvim_win_set_cursor(0, { 1, 0 })
            vim.cmd("normal o")
            vim.cmd("stopinsert")
            local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
            assert.are.equal(2, #lines)
            assert.are.equal("- item one", lines[1])
            assert.are.equal("- ", lines[2])
        end)

        it("clears empty bullet prefix", function()
            vim.api.nvim_buf_set_lines(buf, 0, -1, false, { "- " })
            vim.api.nvim_win_set_cursor(0, { 1, 0 })
            vim.cmd("normal o")
            local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
            assert.are.equal("", lines[1])
        end)

        it("continues numbered list with increment", function()
            vim.api.nvim_buf_set_lines(buf, 0, -1, false, { "1. first" })
            vim.api.nvim_win_set_cursor(0, { 1, 0 })
            vim.cmd("normal o")
            vim.cmd("stopinsert")
            local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
            assert.are.equal("2. ", lines[2])
        end)

        it("continues checkbox list unchecked", function()
            vim.api.nvim_buf_set_lines(buf, 0, -1, false, { "- [ ] task" })
            vim.api.nvim_win_set_cursor(0, { 1, 0 })
            vim.cmd("normal o")
            vim.cmd("stopinsert")
            local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
            assert.are.equal("- [ ] ", lines[2])
        end)
    end)

    describe("O (open line above)", function()
        it("inserts prefix above current line", function()
            vim.api.nvim_buf_set_lines(buf, 0, -1, false, { "- item one" })
            vim.api.nvim_win_set_cursor(0, { 1, 0 })
            vim.cmd("normal O")
            vim.cmd("stopinsert")
            local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
            assert.are.equal(2, #lines)
            assert.are.equal("- ", lines[1])
            assert.are.equal("- item one", lines[2])
        end)
    end)

    describe("CR (insert mode mapping)", function()
        it("has buffer-local CR mapping", function()
            local maps = vim.api.nvim_buf_get_keymap(buf, "i")
            local cr_map = nil
            for _, m in ipairs(maps) do
                if m.lhs == "<CR>" then
                    cr_map = m
                    break
                end
            end
            assert.is_not_nil(cr_map)
            assert.is_truthy(cr_map.callback)
        end)

        it("continues bullet list via direct call", function()
            vim.api.nvim_buf_set_lines(buf, 0, -1, false, { "- item one" })
            vim.api.nvim_win_set_cursor(0, { 1, 9 })
            local maps = vim.api.nvim_buf_get_keymap(buf, "i")
            local cr_fn
            for _, m in ipairs(maps) do
                if m.lhs == "<CR>" then
                    cr_fn = m.callback
                    break
                end
            end
            assert.is_not_nil(cr_fn)
            cr_fn()
            local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
            assert.are.equal(2, #lines)
            assert.are.equal("- ", lines[2])
        end)

        it("clears empty bullet prefix via direct call", function()
            vim.api.nvim_buf_set_lines(buf, 0, -1, false, { "- " })
            vim.api.nvim_win_set_cursor(0, { 1, 1 })
            local maps = vim.api.nvim_buf_get_keymap(buf, "i")
            local cr_fn
            for _, m in ipairs(maps) do
                if m.lhs == "<CR>" then
                    cr_fn = m.callback
                    break
                end
            end
            assert.is_not_nil(cr_fn)
            cr_fn()
            local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
            assert.are.equal("", lines[1])
        end)
    end)
end)