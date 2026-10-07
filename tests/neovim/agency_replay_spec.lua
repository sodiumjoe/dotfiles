package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path

describe("Agency history replay", function()
    local f, saved_hooks
    before_each(function()
        f = require("fixtures.agency_native").new()
        saved_hooks = require("agentic.config").hooks
    end)
    after_each(function()
        require("agentic.config").hooks = saved_hooks
        f.close()
    end)

    local function update(value, replay)
        f.client:_handle_message({ method = "session/update", params = {
            sessionId = "agency:" .. f.row.record.definition.agentId, update = value,
            _meta = { agency = { replay = replay ~= false } },
        } })
    end
    local function text(kind, value, replay)
        update({ sessionUpdate = kind, content = { type = "text", text = value } }, replay)
    end
    local function finish()
        local frame = f.request("session/load")
        f.client:_handle_message({ id = frame.id, result = { sessionId = "agency:" .. f.row.record.definition.agentId,
            _meta = { agency = { version = 1, binding = f.row.record.launch, backendId = "codex-acp",
                configuration = { configOptions = {}, availableCommands = {} } } } } })
        f.flush()
    end

    it("renders adjacent replay chunks with bounded buffer edits", function()
        f.manager:load_acp_session(f.manager.session_id)
        local buffer = f.manager.widget.buf_nrs.chat
        local tick = vim.api.nvim_buf_get_changedtick(buffer)
        for _ = 1, 300 do text("agent_message_chunk", "x") end
        finish()
        assert.are.equal(string.rep("x", 300), f.manager.chat_history.messages[1].text)
        assert.is_true(vim.api.nvim_buf_get_changedtick(buffer) - tick < 15)
        assert.is_false(f.manager._is_restoring_session)
    end)

    it("scrolls once per replay batch and finishes at the end of history", function()
        f.manager:load_acp_session(f.manager.session_id)
        local writer, scrolls = f.manager.message_writer, 0
        local apply = writer._apply_scroll
        writer._apply_scroll = function(self, ...)
            scrolls = scrolls + 1
            return apply(self, ...)
        end
        for _ = 1, 100 do text("agent_message_chunk", "line\n") end
        finish()
        assert.is_true(scrolls < 5)
        local buffer, window = f.manager.widget.buf_nrs.chat, f.manager.widget.win_nrs.chat
        assert.are.equal(vim.api.nvim_buf_line_count(buffer), vim.api.nvim_win_get_cursor(window)[1])
    end)

    it("preserves user thought tool and output ordering through restoration", function()
        f.manager:load_acp_session(f.manager.session_id)
        text("user_message_chunk", "question")
        text("agent_thought_chunk", "think")
        text("agent_thought_chunk", "ing")
        text("agent_message_chunk", "before")
        update({ sessionUpdate = "tool_call", toolCallId = "replay-tool", title = "Tool", kind = "other", status = "pending" })
        update({ sessionUpdate = "tool_call_update", toolCallId = "replay-tool", status = "in_progress",
            content = { { type = "content", content = { type = "text", text = "first" } } } })
        update({ sessionUpdate = "tool_call_update", toolCallId = "replay-tool", status = "completed",
            content = { { type = "content", content = { type = "text", text = "second" } } } })
        text("agent_message_chunk", "after")
        finish()
        local messages = f.manager.chat_history.messages
        assert.are.same({ "user", "thought", "agent", "tool_call", "agent" }, vim.tbl_map(function(msg) return msg.type end, messages))
        assert.are.equal("question", messages[1].text)
        assert.are.equal("thinking", messages[2].text)
        assert.are.equal("before", messages[3].text)
        assert.are.equal("completed", messages[4].status)
        assert.are.same({ "first", "", "---", "", "second" }, messages[4].body)
        assert.are.equal("after", messages[5].text)
    end)

    it("combines native message chunks only when message identity and metadata match", function()
        local received, original = {}, f.manager._on_session_update
        f.manager._on_session_update = function(self, value)
            if value.content then received[#received + 1] = { value.content.text, value.messageId, value._meta } end
            return original(self, value)
        end
        update({ sessionUpdate = "agent_message_chunk", messageId = "message-a", _meta = { phase = "answer" }, content = { type = "text", text = "one" } })
        update({ sessionUpdate = "agent_message_chunk", messageId = "message-a", _meta = { phase = "answer" }, content = { type = "text", text = " two" } })
        update({ sessionUpdate = "agent_message_chunk", messageId = "message-b", _meta = { phase = "answer" }, content = { type = "text", text = " three" } })
        update({ sessionUpdate = "agent_message_chunk", messageId = "message-b", _meta = { phase = "other" }, content = { type = "text", text = " four" } })
        f.flush()
        assert.are.same({ { "one two", "message-a", { phase = "answer" } }, { " three", "message-b", { phase = "answer" } },
            { " four", "message-b", { phase = "other" } } }, received)
        assert.are.equal("one two three four", f.manager.chat_history.messages[1].text)
    end)

    it("keeps intervening live chunks separate from replay chunks", function()
        local received, original = {}, f.manager._on_session_update
        f.manager._on_session_update = function(self, value)
            if value.content and value.content.type == "text" then received[#received + 1] = value.content.text end
            return original(self, value)
        end
        text("agent_message_chunk", "old")
        text("agent_message_chunk", " history")
        text("agent_message_chunk", " live", false)
        text("agent_message_chunk", " tail")
        f.flush()
        assert.are.same({ "old history", " live", " tail" }, received)
        assert.are.equal("old history live tail", f.manager.chat_history.messages[1].text)
    end)

    it("preserves permission arrival order between replay updates", function()
        update({ sessionUpdate = "tool_call", toolCallId = "permission-tool", kind = "other", status = "pending" })
        f.client:_handle_message({ id = "permission-replay", method = "session/request_permission", params = {
            sessionId = f.manager.session_id, toolCall = { toolCallId = "permission-tool", title = "Tool", kind = "other", status = "pending" },
            options = { { optionId = "allow", name = "Allow", kind = "allow_once" } },
            _meta = { agency = { version = 1, binding = vim.deepcopy(f.manager._agency_binding), requestId = "permission-replay" } },
        } })
        update({ sessionUpdate = "tool_call_update", toolCallId = "permission-tool", status = "completed" })
        f.flush()
        assert.are.equal("completed", f.manager.message_writer.tool_call_blocks["permission-tool"].status)
        assert.is_false(f.manager.permission_manager:has_pending())
    end)

    it("preserves live streaming hooks and individual text chunks", function()
        local received = {}
        require("agentic.config").hooks = { on_session_update = function(data)
            received[#received + 1] = data.update.content.text
        end }
        text("agent_message_chunk", "live one", false)
        text("agent_message_chunk", " live two", false)
        f.flush()
        assert.are.same({ "live one", " live two" }, received)
        assert.are.equal("live one live two", f.manager.chat_history.messages[1].text)
    end)

    it("discards queued replay after a replacement load", function()
        f.manager:load_acp_session(f.manager.session_id)
        text("agent_message_chunk", "superseded")
        f.manager:load_acp_session("agency:" .. f.row.record.definition.agentId)
        text("agent_message_chunk", "replacement")
        finish()
        assert.are.equal(1, #f.manager.chat_history.messages)
        assert.are.equal("replacement", f.manager.chat_history.messages[1].text)
    end)

    it("does not move a reader who has scrolled away from the end", function()
        text("agent_message_chunk", string.rep("older line\n", 100), false)
        f.flush()
        local window = f.manager.widget.win_nrs.chat
        vim.api.nvim_win_set_cursor(window, { 2, 0 })
        for _ = 1, 100 do text("agent_message_chunk", "more\n") end
        f.flush()
        assert.are.equal(2, vim.api.nvim_win_get_cursor(window)[1])
        assert.are.equal(200, select(2, f.manager.chat_history.messages[1].text:gsub("\n", "")))
    end)
end)