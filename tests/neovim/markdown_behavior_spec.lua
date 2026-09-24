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

        it("continues bullet list at the end of the line", function()
            vim.api.nvim_buf_set_lines(buf, 0, -1, false, { "- item one" })
            vim.api.nvim_win_set_cursor(0, { 1, 9 })
            vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("a<CR>", true, false, true), "x", false)
            local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
            vim.cmd("stopinsert")
            assert.are.equal(2, #lines)
            assert.are.equal("- ", lines[2])
        end)

        it("splits supported list forms at the cursor", function()
            local cases = {
                { line = "- alpha beta", col = 6, expected = { "- alpha", "- Xbeta" } },
                { line = "9. alpha beta", col = 7, expected = { "9. alpha", "10. Xbeta" } },
                { line = "- [x] alpha beta", col = 10, expected = { "- [x] alpha", "- [ ] Xbeta" } },
                { line = "  * alpha beta", col = 8, expected = { "  * alpha", "  * Xbeta" } },
                { line = "- café noir", col = 5, expected = { "- café", "- Xnoir" } },
            }
            for _, case in ipairs(cases) do
                vim.api.nvim_buf_set_lines(buf, 0, -1, false, { case.line })
                vim.api.nvim_win_set_cursor(0, { 1, case.col })
                vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("a<CR>X<Esc>", true, false, true), "x", false)
                local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
                assert.are.same(case.expected, lines)
            end
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