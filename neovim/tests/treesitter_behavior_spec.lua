describe("treesitter filetype startup", function()
    local spec = require("sodium.plugins.treesitter")[1]
    local original_active

    before_each(function()
        original_active = vim.treesitter.highlighter.active
        vim.treesitter.highlighter.active = {}
        vim.api.nvim_clear_autocmds({ event = "FileType" })
        spec.config()
        vim.treesitter.language.register("markdown", "AgenticChat")
    end)

    after_each(function()
        vim.treesitter.highlighter.active = original_active
    end)

    it("starts treesitter for agentic chat buffers", function()
        local buf = vim.api.nvim_create_buf(false, true)
        vim.bo[buf].buftype = "nofile"
        vim.bo[buf].filetype = "AgenticChat"
        assert.is_not_nil(vim.treesitter.highlighter.active[buf])
        vim.api.nvim_buf_delete(buf, { force = true })
    end)
end)
