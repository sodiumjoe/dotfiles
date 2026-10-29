package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path

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
        local received, scrolls = {}, 0
        require("agentic.config").hooks = { on_session_update = function(data)
            received[#received + 1] = data.update.content.text
        end }
        local apply = writer._apply_scroll
        writer._apply_scroll = function(self, ...)
            scrolls = scrolls + 1
            return apply(self, ...)
        end
        for _ = 1, 100 do deliver(chunk("x")) end
        assert.is_true(vim.wait(300, function() return #renders > 0 and #received == 100 end, 1))
        assert.are.equal(1, #renders)
        assert.are.equal(1, scrolls)
        assert.are.equal(string.rep("x", 100), f.manager.chat_history.messages[1].text)
        assert.are.equal(string.rep("x", 100), renders[1].content.text)
    end)

    it("flushes on a fixed deadline while more text arrives", function()
        f.manager:_on_session_update(chunk("first"))
        assert.are.equal(0, #renders)
        assert.is_true(vim.wait(100, function()
            f.manager:_on_session_update(chunk("x"))
            return #renders > 0
        end, 2))
        assert.is_true(renders[1].content.text:find("first", 1, true) == 1)
    end)

    it("bounds accumulated text by 32 KiB", function()
        for _ = 1, 32 do f.manager:_on_session_update(chunk(string.rep("x", 1024))) end
        assert.are.equal(1, #renders)
        assert.are.equal(32768, #renders[1].content.text)
    end)


    it("flushes before another chunk would exceed the batch cap", function()
        local text = string.rep("x", 20 * 1024)
        f.manager:_on_session_update(chunk(text))
        f.manager:_on_session_update(chunk(text))
        assert.are.equal(1, #renders)
        assert.are.equal(20 * 1024, #renders[1].content.text)
        f.flush()
        assert.are.equal(2, #renders)
        assert.are.equal(20 * 1024, #renders[2].content.text)
        assert.are.equal(text .. text, f.manager.chat_history.messages[1].text)
    end)

    it("separates thought roles message identities and metadata", function()
        f.manager:_on_session_update(chunk("think", { sessionUpdate = "agent_thought_chunk" }))
        f.manager:_on_session_update(chunk("one", { messageId = "a", _meta = { phase = "a" } }))
        f.manager:_on_session_update(chunk(" two", { messageId = "a", _meta = { phase = "a" } }))
        f.manager:_on_session_update(chunk("three", { messageId = "b", _meta = { phase = "a" } }))
        f.manager:_on_session_update(chunk("four", { messageId = "b", _meta = { phase = "b" } }))
        f.flush()
        assert.are.same({ "think", "one two", "three", "four" }, vim.tbl_map(function(u) return u.content.text end, renders))
        assert.are.same({ "thought", "agent" }, vim.tbl_map(function(m) return m.type end, f.manager.chat_history.messages))
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

    it("flushes before another local user message", function()
        f.manager:_on_session_update(chunk("partial answer"))
        f.manager:_handle_input_submit("next question")
        local text = buffer_text()
        assert.is_true(text:find("partial answer", 1, true) < text:find("next question", 1, true))
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

    it("flushes accepted partial text on explicit stop", function()
        f.manager._agency_turn_id = "turn"
        f.manager:_on_session_update(chunk("partial"))
        f.client:stop_generation(f.manager.session_id)
        assert.are.equal(1, #renders)
        assert.is_truthy(buffer_text():find("partial", 1, true))
    end)

    it("discards queued rendering on cancellation replacement and destruction", function()
        for _, transition in ipairs({ "_cancel_session", "load_acp_session", "destroy" }) do
            if transition ~= "_cancel_session" then f.close(); f = require("fixtures.agency_native").new() end
            writer, renders = f.manager.message_writer, {}
            local write = writer.write_message_chunk
            writer.write_message_chunk = function(self, update)
                renders[#renders + 1] = update.content.text
                return write(self, update)
            end
            f.manager:_on_session_update(chunk("obsolete"))
            f.manager[transition](f.manager, f.manager.session_id)
            f.flush()
            assert.are.same({}, renders)
        end
    end)

    it("flushes delivered text before transport invalidation", function()
        f.manager:_on_session_update(chunk("accepted partial"))
        f.client:_set_state("disconnected")
        assert.are.equal(1, #renders)
        assert.is_truthy(buffer_text():find("accepted partial", 1, true))
    end)


    it("flushes delivered text safely when transport loss comes from a fast event", function()
        f.manager:_on_session_update(chunk("fast partial"))
        local done, failure
        local timer = vim.uv.new_timer()
        timer:start(0, 0, function()
            local ok, err = pcall(f.client._set_state, f.client, "disconnected")
            if not ok then failure = err end
            timer:stop()
            timer:close()
            done = true
        end)
        assert.is_true(vim.wait(100, function() return done end, 1))
        assert.is_nil(failure)
        f.flush()
        assert.is_truthy(buffer_text():find("fast partial", 1, true))
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


    it("flushes before a delivered error message", function()
        deliver(chunk("before error"))
        local handlers = f.client.subscribers[f.manager.session_id]
        f.client:__with_subscriber(f.manager.session_id, function() handlers.on_error({ message = "synthetic error" }) end)
        f.flush()
        local text = buffer_text()
        assert.is_true(text:find("before error", 1, true) < text:find("synthetic error", 1, true))
    end)

    it("leaves direct provider chunks synchronous", function()
        local provider = f.client.provider_config
        f.client.provider_config = { name = "Direct" }
        local ok, err = pcall(f.manager._on_session_update, f.manager, chunk("direct"))
        f.client.provider_config = provider
        assert.is_true(ok, tostring(err))
        assert.are.equal(1, #renders)
        assert.is_truthy(buffer_text():find("direct", 1, true))
    end)

    it("does not render a queued chunk into a replaced writer", function()
        f.manager:_on_session_update(chunk("old writer"))
        local replacement = require("agentic.ui.message_writer"):new(vim.api.nvim_create_buf(false, true))
        f.manager.message_writer = replacement
        f.flush()
        assert.are.equal(0, #renders)
        assert.is_falsy(table.concat(vim.api.nvim_buf_get_lines(replacement.bufnr, 0, -1, false), ""):find("old writer", 1, true))
        f.manager.message_writer = writer
        vim.api.nvim_buf_delete(replacement.bufnr, { force = true })
    end)

    it("flushes live rendering before replay entry", function()
        deliver(chunk("live"))
        f.client:_handle_message({ method = "session/update", params = { sessionId = f.manager.session_id,
            update = chunk(" replay"), _meta = { agency = { replay = true } } } })
        f.flush()
        assert.are.same({ "live", " replay" }, vim.tbl_map(function(u) return u.content.text end, renders))
        assert.is_truthy(buffer_text():find("live replay", 1, true))
    end)
end)