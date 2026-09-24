describe("RestoreCursorPos", function()
    local tmpfile

    before_each(function()
        tmpfile = vim.fn.tempname() .. ".lua"
        local lines = {}
        for i = 1, 10 do
            lines[i] = "line " .. i
        end
        vim.fn.writefile(lines, tmpfile)
    end)

    after_each(function()
        vim.fn.delete(tmpfile)
    end)

    it("restores cursor to last position on reopen", function()
        local scratch = vim.api.nvim_create_buf(true, false)
        vim.cmd.edit(tmpfile)
        vim.api.nvim_win_set_cursor(0, { 7, 0 })
        vim.cmd.write()
        local tmpbuf = vim.fn.bufnr(tmpfile)
        vim.api.nvim_set_current_buf(scratch)
        vim.cmd("bunload " .. tmpbuf)
        vim.cmd.edit(tmpfile)
        local row = vim.api.nvim_win_get_cursor(0)[1]
        assert.are.equal(7, row)
        vim.cmd("bdelete! " .. vim.fn.bufnr(tmpfile))
        vim.api.nvim_buf_delete(scratch, { force = true })
    end)
end)