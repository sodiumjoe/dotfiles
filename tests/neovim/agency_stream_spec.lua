package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
dofile(vim.env.DOTFILES_TEST_ROOT .. "/home/.config/nvim/lua/sodium/plugins/agentic.lua").config()

describe("Agency live rendering", function()
    local f, hooks, writer, renders
    before_each(function()
        f = require("fixtures.agency_native").new()
        hooks = require("agentic.config").hooks
        writer, renders = f.manager.message_writer, {}
        local write = writer.write_message_chunk
        writer.write_message_chunk = function(self, update)
            renders[#renders + 1] = vim.deepcopy(update)
            return write(self, update)
        end
    end)
    after_each(function()
        require("agentic.config").hooks = hooks
        f.close()
    end)
    local function chunk(text, fields)
        return vim.tbl_extend("force", { sessionUpdate = "agent_message_chunk", content = { type = "text", text = text } }, fields or {})
    end
    local function deliver(value)
        f.client:_handle_message({ method = "session/update", params = { sessionId = f.manager.session_id, update = value } })
    end
    local function buffer_text()
        return table.concat(vim.api.nvim_buf_get_lines(writer.bufnr, 0, -1, false), "\n")
    end


    it("combines a delivered burst while preserving every history update and hook", function()
        local received = {}
        require("agentic.config").hooks = { on_session_update = function(data)
            received[#received + 1] = data.update.content.text
        end }
        local expected = {}
        for i = 1, 100 do
            expected[i] = string.format("%03d ", i)
            deliver(chunk(expected[i]))
        end
        assert.is_true(vim.wait(300, function() return #renders > 0 and #received == 100 end, 1))
        assert.are.same(expected, received)
        local text = table.concat(expected)
        assert.are.equal(text, f.manager.chat_history.messages[1].text)
        local displayed = {}
        for _, render in ipairs(renders) do displayed[#displayed + 1] = render.content.text end
        assert.are.equal(text, table.concat(displayed))
        assert.is_truthy(buffer_text():find(vim.trim(text), 1, true))
    end)

    it("flushes before a delivered tool and permission request", function()
        local before_tool, before_permission
        local tool = writer.write_tool_call_block
        writer.write_tool_call_block = function(self, value)
            before_tool = buffer_text():find("before tool", 1, true) ~= nil
            return tool(self, value)
        end
        local request = f.manager.permission_manager.add_request
        f.manager.permission_manager.add_request = function(self, ...)
            before_permission = buffer_text():find("before permission", 1, true) ~= nil
            return request(self, ...)
        end
        deliver(chunk("before tool"))
        deliver({ sessionUpdate = "tool_call", toolCallId = "tool", title = "Tool", kind = "other", status = "pending" })
        deliver(chunk("before permission"))
        f.client:_handle_message({ id = "permission", method = "session/request_permission", params = {
            sessionId = f.manager.session_id, toolCall = { toolCallId = "tool", title = "Tool", kind = "other", status = "pending" },
            options = { { optionId = "allow", name = "Allow", kind = "allow_once" } },
            _meta = { agency = { version = 1, binding = vim.deepcopy(f.manager._agency_binding) } },
        } })
        f.flush()
        assert.is_true(before_tool)
        assert.is_true(before_permission)
        local text = buffer_text()
        assert.is_true(text:find("before tool", 1, true) < text:find("Tool", 1, true))
    end)

    it("flushes before completion and its hook", function()
        f.manager:_handle_input_submit("question")
        local complete
        require("agentic.config").hooks = { on_response_complete = function()
            complete = buffer_text():find("final answer", 1, true) ~= nil
        end }
        local finish = writer.write_finish_message
        writer.write_finish_message = function(self, ...)
            assert.is_truthy(buffer_text():find("final answer", 1, true))
            return finish(self, ...)
        end
        deliver(chunk("final answer"))
        f.client:_handle_message({ id = f.request("session/prompt").id, result = { stopReason = "end_turn" } })
        f.flush()
        assert.is_true(complete)
    end)

    it("folds queued thinking on remote idle and preserves it through a new turn", function()
        f.state("remote-turn", "running")
        deliver(chunk("idle first\nidle second", { sessionUpdate = "agent_thought_chunk" }))
        f.state("remote-turn", "idle")
        local first
        for index, text in ipairs(vim.api.nvim_buf_get_lines(writer.bufnr, 0, -1, false)) do
            if text:find("idle first", 1, true) then first = index end
        end
        assert.is_not_nil(first)
        local function check_fold()
            vim.api.nvim_win_call(f.manager.widget.win_nrs.chat, function()
                assert.are.equal(first, vim.fn.foldclosed(first))
                assert.are.equal(first + 1, vim.fn.foldclosedend(first))
            end)
        end
        check_fold()
        f.state("next-turn", "running")
        deliver(chunk("next thought", { sessionUpdate = "agent_thought_chunk" }))
        f.flush()
        check_fold()
        local next_line
        for index, text in ipairs(vim.api.nvim_buf_get_lines(writer.bufnr, 0, -1, false)) do
            if text:find("next thought", 1, true) then next_line = index end
        end
        assert.is_true(next_line > first + 1)
        vim.api.nvim_win_call(f.manager.widget.win_nrs.chat, function()
            assert.are.equal(-1, vim.fn.foldclosed(next_line))
        end)
        deliver(chunk("next answer"))
        f.flush()
        check_fold()
    end)

    it("folds each completed thinking block after a retained replay batch", function()
        for _, update in ipairs({
            chunk("replay first\nreplay second", { sessionUpdate = "agent_thought_chunk" }),
            chunk("replay answer"),
            chunk("replay later", { sessionUpdate = "agent_thought_chunk" }),
            chunk("replay final answer"),
        }) do
            f.client:_handle_message({ method = "session/update", params = {
                sessionId = f.manager.session_id, update = update, _meta = { agency = { replay = true } },
            } })
        end
        f.flush()
        local found = {}
        for index, text in ipairs(vim.api.nvim_buf_get_lines(writer.bufnr, 0, -1, false)) do
            for _, value in ipairs({ "replay first", "replay later", "replay final answer" }) do
                if text:find(value, 1, true) then found[value] = index end
            end
        end
        vim.api.nvim_win_call(f.manager.widget.win_nrs.chat, function()
            assert.are.equal(found["replay first"], vim.fn.foldclosed(found["replay first"]))
            assert.are.equal(found["replay first"] + 1, vim.fn.foldclosedend(found["replay first"]))
            assert.are.equal(found["replay later"], vim.fn.foldclosed(found["replay later"]))
            assert.are.equal(found["replay later"], vim.fn.foldclosedend(found["replay later"]))
            assert.are.equal(-1, vim.fn.foldclosed(found["replay final answer"]))
        end)
    end)

    it("keeps a reader who scrolls away during the batching window", function()
        f.manager:_on_session_update(chunk(string.rep("older line\n", 100)))
        f.flush()
        f.manager:_on_session_update(chunk("new line\n"))
        vim.api.nvim_win_set_cursor(f.manager.widget.win_nrs.chat, { 2, 0 })
        f.flush()
        assert.are.equal(2, vim.api.nvim_win_get_cursor(f.manager.widget.win_nrs.chat)[1])
        assert.is_truthy(buffer_text():find("new line", 1, true))
    end)
end)