local diff = require("sodium.diff")

describe("sodium.diff", function()
    describe("_scratch_buffer", function()
        it("creates a nofile buffer with given content", function()
            local lines = { "line 1", "line 2", "line 3" }
            local buf = diff._scratch_buffer("test.lua (HEAD)", lines, "lua")

            assert.are.same(lines, vim.api.nvim_buf_get_lines(buf, 0, -1, false))
            assert.are.equal("nofile", vim.bo[buf].buftype)
            assert.are.equal("wipe", vim.bo[buf].bufhidden)
            assert.is_false(vim.bo[buf].modifiable)
            assert.are.equal("lua", vim.bo[buf].filetype)
            assert.is_true(vim.api.nvim_buf_get_name(buf):match("test.lua %(HEAD%)$") ~= nil)

            vim.api.nvim_buf_delete(buf, { force = true })
        end)

        it("works without filetype", function()
            local buf = diff._scratch_buffer("unnamed", { "hello" }, nil)

            assert.are.equal("", vim.bo[buf].filetype)
            vim.api.nvim_buf_delete(buf, { force = true })
        end)
    end)

    describe("_filetype_from_path", function()
        it("detects lua filetype", function()
            assert.are.equal("lua", diff._filetype_from_path("foo/bar.lua"))
        end)

        it("detects python filetype", function()
            assert.are.equal("python", diff._filetype_from_path("script.py"))
        end)

        it("returns nil for unknown extension", function()
            assert.is_nil(diff._filetype_from_path("file.xyz123"))
        end)
    end)

    describe("open - files mode", function()
        it("opens two buffers in diff mode", function()
            local left = vim.fn.tempname() .. ".lua"
            local right = vim.fn.tempname() .. ".lua"
            vim.fn.writefile({ "left content" }, left)
            vim.fn.writefile({ "right content" }, right)

            diff.open({ mode = "files", left = left, right = right })

            local wins = vim.api.nvim_list_wins()
            assert.are.equal(2, #wins)

            local left_win, right_win = wins[1], wins[2]
            assert.is_true(vim.wo[left_win].diff)
            assert.is_true(vim.wo[right_win].diff)

            local left_name = vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(left_win))
            local right_name = vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(right_win))
            assert.is_true(left_name:match("%.lua$") ~= nil)
            assert.is_true(right_name:match("%.lua$") ~= nil)

            vim.cmd("only")
            vim.cmd("enew")
            os.remove(left)
            os.remove(right)
        end)
    end)
end)
