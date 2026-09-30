describe("agentic chat path:line links", function()
    local spec = require("sodium.plugins.agentic")
    local target_name = "agentic-chat-link-target.txt"
    local home_target = vim.fn.expand("~/agentic-chat-link-target.txt")

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
        pcall(vim.fn.delete, home_target)
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

    it("opens Agentic smart-path references with #Lx-Ly anchors", function()
        setup_agentic_config()

        vim.fn.writefile({ "one", "two", "three" }, home_target)

        local buf = vim.api.nvim_create_buf(false, true)
        vim.api.nvim_set_current_buf(buf)
        vim.bo[buf].buftype = "nofile"
        vim.bo[buf].filetype = "AgenticChat"

        local smart_path = vim.fn.fnamemodify(home_target, ":~")
        local line = "```markdown " .. smart_path .. "#L2-L3"
        local path_col = assert(line:find(smart_path, 1, true))

        vim.api.nvim_buf_set_lines(buf, 0, -1, false, { line })
        vim.api.nvim_win_set_cursor(0, { 1, path_col })

        local gf_map = find_buffer_map(buf, "gf")
        assert.is_not_nil(gf_map)
        assert.is_truthy(gf_map.callback)

        assert.has_no.errors(function()
            gf_map.callback()
        end)

        assert.are.equal(home_target, vim.api.nvim_buf_get_name(0))
        assert.are.equal(2, vim.api.nvim_win_get_cursor(0)[1])
    end)

    local function gf_on(line, col)
        setup_agentic_config()

        local buf = vim.api.nvim_create_buf(false, true)
        vim.api.nvim_set_current_buf(buf)
        vim.bo[buf].buftype = "nofile"
        vim.bo[buf].filetype = "AgenticChat"
        vim.api.nvim_buf_set_lines(buf, 0, -1, false, { line })
        vim.api.nvim_win_set_cursor(0, { 1, col })

        local gf_map = find_buffer_map(buf, "gf")
        assert.is_not_nil(gf_map)
        gf_map.callback()
    end

    it("opens the destination of a markdown link when the cursor is on its label", function()
        local target = vim.fn.tempname()
        vim.fn.writefile({ "one", "two" }, target)

        local line = "see [foo](" .. target .. ") here"
        gf_on(line, assert(line:find("foo", 1, true)))

        assert.are.equal(vim.fn.resolve(target), vim.fn.resolve(vim.api.nvim_buf_get_name(0)))
        assert.are.equal(1, vim.api.nvim_win_get_cursor(0)[1])
        vim.fn.delete(target)
    end)

    it("honors line anchors and angle-bracket destinations in markdown links", function()
        local target = vim.fn.tempname()
        vim.fn.writefile({ "one", "two", "three" }, target)

        local line = "[a](x) and [foo bar](<" .. target .. "#L3>)"
        gf_on(line, assert(line:find("bar", 1, true)))

        assert.are.equal(vim.fn.resolve(target), vim.fn.resolve(vim.api.nvim_buf_get_name(0)))
        assert.are.equal(3, vim.api.nvim_win_get_cursor(0)[1])
        vim.fn.delete(target)
    end)

    it("opens references in the editor window without entering the target buffer in the widget window", function()
        setup_agentic_config()

        vim.fn.writefile({ "one", "two", "three" }, target_name)
        local target_path = vim.fn.fnamemodify(target_name, ":p")

        local editor_buf = vim.api.nvim_create_buf(false, true)
        vim.api.nvim_set_current_buf(editor_buf)
        local editor_win = vim.api.nvim_get_current_win()

        local chat_buf = vim.api.nvim_create_buf(false, true)
        vim.bo[chat_buf].buftype = "nofile"
        vim.bo[chat_buf].filetype = "AgenticChat"
        vim.api.nvim_buf_set_lines(chat_buf, 0, -1, false, {
            "See " .. target_name .. ":2 for context",
        })
        local chat_win = vim.api.nvim_open_win(chat_buf, true, { split = "below" })
        vim.w[chat_win].agentic_bufnr = chat_buf
        vim.api.nvim_win_set_cursor(chat_win, { 1, 6 })

        local entered_wins = {}
        local group = vim.api.nvim_create_augroup("AgenticChatLinksSpec", { clear = true })
        vim.api.nvim_create_autocmd("BufEnter", {
            group = group,
            callback = function(ev)
                if vim.api.nvim_buf_get_name(ev.buf) == target_path then
                    table.insert(entered_wins, vim.api.nvim_get_current_win())
                end
            end,
        })

        local gf_map = find_buffer_map(chat_buf, "gf")
        assert.is_not_nil(gf_map)
        gf_map.callback()
        vim.api.nvim_del_augroup_by_id(group)

        assert.are.same({ editor_win }, entered_wins)
        assert.are.equal(editor_win, vim.api.nvim_get_current_win())
        assert.are.equal(target_path, vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(editor_win)))
        assert.are.equal(2, vim.api.nvim_win_get_cursor(editor_win)[1])
        assert.are.equal(chat_buf, vim.api.nvim_win_get_buf(chat_win))

        vim.api.nvim_win_close(chat_win, true)
        vim.api.nvim_buf_delete(chat_buf, { force = true })
        vim.api.nvim_buf_delete(editor_buf, { force = true })
    end)
end)
