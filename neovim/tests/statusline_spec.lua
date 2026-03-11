describe("sodium.statusline", function()
    local statusline

    before_each(function()
        statusline = require("sodium.statusline")
    end)

    describe("get_filename", function()
        it("returns staged prefix for fugitive buffers", function()
            local buf = vim.api.nvim_create_buf(false, true)
            vim.api.nvim_set_current_buf(buf)
            vim.api.nvim_buf_set_name(buf, "fugitive:///Users/moon/.dotfiles//abc123def/src/foo.lua")
            assert.are.equal("[staged]: src/foo.lua", statusline.get_filename())
            vim.api.nvim_buf_delete(buf, { force = true })
        end)

        it("returns relative path for normal buffers", function()
            local buf = vim.api.nvim_create_buf(false, true)
            vim.api.nvim_set_current_buf(buf)
            vim.api.nvim_buf_set_name(buf, "/tmp/test_statusline_file.lua")
            local result = statusline.get_filename()
            assert.is_truthy(result)
            assert.is_not.equal("", result)
            vim.api.nvim_buf_delete(buf, { force = true })
        end)
    end)

    describe("get_agentic_title", function()
        local original_ft

        before_each(function()
            original_ft = vim.bo.filetype
        end)

        after_each(function()
            vim.bo.filetype = original_ft
        end)

        it("returns chat title for AgenticChat", function()
            vim.bo.filetype = "AgenticChat"
            assert.are.equal("󰻞 Agentic Chat", statusline.get_agentic_title())
        end)

        it("returns prompt title for AgenticInput", function()
            vim.bo.filetype = "AgenticInput"
            assert.are.equal("󰦨 Prompt", statusline.get_agentic_title())
        end)

        it("returns code title for AgenticCode", function()
            vim.bo.filetype = "AgenticCode"
            assert.are.equal("󰪸 Selected Code Snippets", statusline.get_agentic_title())
        end)

        it("returns files title for AgenticFiles", function()
            vim.bo.filetype = "AgenticFiles"
            assert.are.equal("󰪸 Referenced Files", statusline.get_agentic_title())
        end)

        it("returns todos title for AgenticTodos", function()
            vim.bo.filetype = "AgenticTodos"
            assert.are.equal("☐ TODO Items", statusline.get_agentic_title())
        end)

        it("returns empty string for other filetypes", function()
            vim.bo.filetype = "lua"
            assert.are.equal("", statusline.get_agentic_title())
        end)
    end)
end)