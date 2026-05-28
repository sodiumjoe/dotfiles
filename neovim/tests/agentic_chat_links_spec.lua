describe("agentic chat path:line links", function()
    local spec = require("sodium.plugins.agentic")
    local target_name = "agentic-chat-link-target.txt"

    local function setup_agentic_config()
        package.loaded.agentic = {
            setup = function()
            end,
        }
        assert.is_function(spec.config)
        spec.config()
        package.loaded.agentic = nil
    end

    local function find_buffer_map(buf, lhs)
        for _, map in ipairs(vim.api.nvim_buf_get_keymap(buf, "n")) do
            if map.lhs == lhs then
                return map
            end
        end
        return nil
    end

    after_each(function()
        pcall(vim.fn.delete, target_name)
    end)

    it("adds a buffer-local gf callback for AgenticChat that opens path:line references", function()
        setup_agentic_config()

        vim.fn.writefile({ "one", "two", "three" }, target_name)

        local buf = vim.api.nvim_create_buf(false, true)
        vim.api.nvim_set_current_buf(buf)
        vim.bo[buf].buftype = "nofile"
        vim.bo[buf].filetype = "AgenticChat"
        vim.api.nvim_buf_set_lines(buf, 0, -1, false, {
            "See " .. target_name .. ":2 for context",
        })
        vim.api.nvim_win_set_cursor(0, { 1, 6 })

        local gf_map = find_buffer_map(buf, "gf")
        assert.is_not_nil(gf_map)
        assert.is_truthy(gf_map.callback)

        gf_map.callback()

        assert.are.equal(vim.fn.fnamemodify(target_name, ":p"), vim.api.nvim_buf_get_name(0))
        assert.are.equal(2, vim.api.nvim_win_get_cursor(0)[1])
    end)
end)