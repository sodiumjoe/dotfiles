describe("AutoCloseQFLL", function()
    local tmpfile

    before_each(function()
        tmpfile = vim.fn.tempname() .. ".lua"
        vim.fn.writefile({ "line 1", "line 2" }, tmpfile)
        vim.cmd.edit(tmpfile)
    end)

    after_each(function()
        vim.cmd.cclose()
        vim.fn.setqflist({})
        vim.fn.delete(tmpfile)
    end)

    it("has buffer-local CR mapping in quickfix", function()
        vim.fn.setqflist({ { filename = tmpfile, lnum = 1, text = "test" } })
        vim.cmd.copen()
        assert.are.equal("qf", vim.bo.filetype)
        local maps = vim.api.nvim_buf_get_keymap(0, "n")
        local cr_map = nil
        for _, m in ipairs(maps) do
            if m.lhs == "<CR>" then
                cr_map = m
                break
            end
        end
        assert.is_not_nil(cr_map)
        assert.is_truthy(cr_map.rhs:find("cclose"))
    end)

    it("closes quickfix window on CR", function()
        vim.fn.setqflist({ { filename = tmpfile, lnum = 1, text = "test" } })
        vim.cmd.copen()
        vim.cmd("normal \r")
        local qf_open = false
        for _, win in ipairs(vim.api.nvim_list_wins()) do
            if vim.api.nvim_get_option_value("filetype", { buf = vim.api.nvim_win_get_buf(win) }) == "qf" then
                qf_open = true
            end
        end
        assert.is_false(qf_open)
    end)
end)