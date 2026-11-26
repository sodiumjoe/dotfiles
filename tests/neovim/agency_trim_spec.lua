package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
dofile(vim.env.DOTFILES_TEST_ROOT .. "/home/.config/nvim/lua/sodium/plugins/agentic.lua").config()

describe("Agency chat trimming", function()
    local f, writer, bufnr, Trim, limits
    local user_header = string.format("## %s User", require("agentic.config").chat_icons.user)
    before_each(function()
        Trim = require("sodium.agency.trim")
        limits = { Trim.LIMIT, Trim.TARGET }
        Trim.LIMIT, Trim.TARGET = 60, 40
        f = require("fixtures.agency_native").new()
        writer = f.manager.message_writer
        bufnr = writer.bufnr
    end)
    after_each(function()
        Trim.LIMIT, Trim.TARGET = unpack(limits)
        f.close()
    end)
    local function deliver(update, replay)
        f.client:_handle_message({
            method = "session/update",
            params = {
                sessionId = f.manager.session_id,
                update = update,
                _meta = replay and { agency = { replay = true } } or nil,
            },
        })
    end
    local function chunk(text, kind)
        return { sessionUpdate = kind or "agent_message_chunk", content = { type = "text", text = text } }
    end
    local function user(text)
        writer:write_message({ sessionUpdate = "user_message_chunk", content = { type = "text", text = text } })
    end
    local function agent(text, kind)
        deliver(chunk(text, kind))
        f.flush()
    end
    local function answer(i, size)
        local lines = {}
        for j = 1, size do
            lines[j] = string.format("answer %d.%d", i, j)
        end
        return table.concat(lines, "\n")
    end
    local function turns(from, to, size)
        for i = from, to do
            user("question " .. i)
            agent(answer(i, size or 2))
        end
    end
    local function lines()
        return vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
    end
    local function is_header(line)
        return line == user_header or line:sub(1, #user_header + 3) == user_header .. " - "
    end
    local function headers(text, quoted)
        local rows = {}
        for index, line in ipairs(text) do
            if is_header(line) and line ~= quoted then
                rows[#rows + 1] = index - 1
            end
        end
        return rows
    end
    local function marker(count)
        return string.format("󰁝 %d earlier turns hidden · <CR> to read them", count)
    end
    local function find(text, value)
        for index, line in ipairs(text) do
            if line == value then
                return index
            end
        end
    end
    local function assert_trimmed(before, after, hidden, quoted)
        local kept, n = #after - 1, #before
        local first = n - kept
        assert.is_true(#after < Trim.TARGET)
        assert.are.same(vim.list_slice(before, first + 1, n), vim.list_slice(after, 2, #after))
        assert.is_true(is_header(after[2]))
        local above, previous = 0, nil
        for _, row in ipairs(headers(before, quoted)) do
            if row < first then
                above, previous = above + 1, row
            end
        end
        assert.is_true(previous ~= nil and 1 + n - previous >= Trim.TARGET)
        assert.are.equal(marker(hidden + above), after[1])
        return above
    end

    it("trims whole oldest turns to under the target once the session goes idle", function()
        turns(1, 8, 2)
        local before = lines()
        assert.is_true(#before > Trim.LIMIT)
        f.state("t8", "idle")
        local removed = assert_trimmed(before, lines(), 0)
        assert.is_true(removed > 0)
        assert.are.equal(removed, Trim.hidden(bufnr))
    end)

    it("adds to the hidden count on a later trim and keeps the marker on row 0", function()
        turns(1, 8, 2)
        f.state("t8", "idle")
        local first = Trim.hidden(bufnr)
        turns(9, 16, 2)
        local before = lines()
        f.state("t16", "idle")
        local after = lines()
        local second = assert_trimmed(before, after, first)
        assert.is_true(second > 0)
        assert.are.equal(first + second, Trim.hidden(bufnr))
        assert.are.equal(0, Trim.marker_row(bufnr))
        local markers = 0
        for _, line in ipairs(after) do
            if line:find("^󰁝 %d+ earlier turns hidden") then
                markers = markers + 1
            end
        end
        assert.are.equal(1, markers)
        assert.are.equal(1, headers(after)[1])
        assert.are_not.equal(headers(after)[1], Trim.marker_row(bufnr))
    end)

    it("does not cut at a header quoted inside an agent's code block", function()
        local quoted = user_header .. " - 2026-01-01 00:00:00"
        turns(1, 4, 2)
        user("question 5")
        agent(table.concat({ "```markdown", answer(5, 14), quoted, "quoted question", "```" }, "\n"))
        turns(6, 8, 2)
        local before = lines()
        local row = find(before, quoted) - 1
        local real = headers(before, quoted)
        assert.is_true(1 + #before - row < Trim.TARGET)
        assert.is_true(1 + #before - real[#real - 3] >= Trim.TARGET)
        f.state("t8", "idle")
        local after = lines()
        assert.are.equal(5, assert_trimmed(before, after, 0, quoted))
        assert.is_nil(find(after, quoted))
        assert.is_nil(find(after, "question 5"))
        assert.are.equal(after[4], "question 6")
    end)

    it("keeps trimming after a tool body with an unbalanced fence", function()
        turns(1, 2, 2)
        deliver({
            sessionUpdate = "tool_call",
            toolCallId = "fence",
            title = "Fence",
            kind = "other",
            status = "completed",
            content = { { type = "content", content = { type = "text", text = "```\nunclosed" } } },
        })
        f.flush()
        turns(3, 8, 2)
        f.state("t8", "idle")
        local first = Trim.hidden(bufnr)
        assert.is_true(first > 0)
        turns(9, 16, 2)
        local before = lines()
        f.state("t16", "idle")
        assert.is_true(assert_trimmed(before, lines(), first) > 0)
    end)

    it("drops the writer's state for trimmed tool blocks", function()
        user("question 1")
        deliver({
            sessionUpdate = "tool_call",
            toolCallId = "old",
            title = "Old tool",
            kind = "other",
            status = "completed",
            content = { { type = "content", content = { type = "text", text = "old body" } } },
        })
        f.flush()
        assert.is_truthy(writer.tool_call_blocks.old)
        turns(2, 9, 2)
        f.state("t9", "idle")
        assert.is_true(Trim.hidden(bufnr) > 0)
        local blocks = require("agentic.ui.tool_call_blocks").NS_TOOL_BLOCKS
        assert.are.same({}, vim.api.nvim_buf_get_extmarks(bufnr, blocks, { 0, 0 }, { 1, -1 }, {}))
        assert.is_nil(writer.tool_call_blocks.old)
        local top = vim.list_slice(lines(), 1, 2)
        deliver({ sessionUpdate = "tool_call_update", toolCallId = "old", title = "Late title", status = "failed" })
        f.flush()
        assert.are.same(top, vim.list_slice(lines(), 1, 2))
    end)

    it("does nothing when no whole turn can be removed", function()
        writer:write_structural_message(chunk(answer(0, 30)))
        user("question 1")
        agent(answer(1, 40))
        local before = lines()
        local real = headers(before)
        assert.are.equal(1, #real)
        assert.is_true(#before > Trim.LIMIT)
        assert.is_true(#before - real[1] <= Trim.LIMIT and 1 + #before - real[1] >= Trim.TARGET)
        f.state("t1", "idle")
        assert.are.same(before, lines())
        assert.is_nil(Trim.marker_row(bufnr))
        assert.are.equal(0, Trim.hidden(bufnr))
    end)

    it("trims nothing when the newest turn alone is over the limit", function()
        turns(1, 3, 2)
        user("question 4")
        agent(answer(4, 70))
        local before = lines()
        f.state("t4", "idle")
        assert.are.same(before, lines())
        assert.is_nil(Trim.marker_row(bufnr))
        assert.are.equal(0, Trim.hidden(bufnr))
    end)

    it("keeps the reader's view on the same text when lines above are removed", function()
        turns(1, 8, 2)
        local win = f.manager.widget.win_nrs.chat
        local before = lines()
        local cursor = find(before, "answer 7.1")
        local top, line
        vim.api.nvim_win_call(win, function()
            vim.api.nvim_win_set_cursor(win, { cursor, 0 })
            vim.fn.winrestview({ topline = cursor - 2 })
            top = vim.fn.getline(vim.fn.line("w0"))
        end)
        f.state("t8", "idle")
        assert.is_true(Trim.hidden(bufnr) > 0)
        vim.api.nvim_win_call(win, function()
            assert.are.equal(top, vim.fn.getline(vim.fn.line("w0")))
            line = vim.fn.getline(".")
        end)
        assert.are.equal("answer 7.1", line)
    end)

    it("keeps a thinking fold in a kept turn closed over the same text", function()
        turns(1, 7, 2)
        user("question 8")
        agent("kept first\nkept second", "agent_thought_chunk")
        agent("kept answer")
        f.state("t8", "idle")
        assert.is_true(Trim.hidden(bufnr) > 0)
        local first = find(lines(), require("agentic.config").message_icons.thinking .. " kept first")
        vim.api.nvim_win_call(f.manager.widget.win_nrs.chat, function()
            assert.are.equal(first, vim.fn.foldclosed(first))
            assert.are.equal(first + 1, vim.fn.foldclosedend(first))
        end)
    end)

    it("trims after a replay batch is flushed", function()
        for i = 1, 8 do
            deliver(chunk("question " .. i, "user_message_chunk"), true)
            deliver(chunk(answer(i, 2)), true)
        end
        f.flush()
        local after = lines()
        assert.is_true(Trim.hidden(bufnr) > 0)
        assert.is_true(#after < Trim.TARGET)
        assert.are.equal(marker(Trim.hidden(bufnr)), after[1])
        assert.is_true(is_header(after[2]))
    end)
end)