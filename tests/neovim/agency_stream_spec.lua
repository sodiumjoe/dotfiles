package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
dofile(vim.env.DOTFILES_TEST_ROOT .. "/home/.config/nvim/lua/sodium/plugins/agentic.lua").config()

describe("Agency live rendering", function()
    local f, hooks, writer, renders
    local control = require("fixtures.agency_control")
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
    local function permission(id, session_id, binding, tool)
        f.client:_handle_message({ id = id, method = "session/request_permission", params = {
            sessionId = session_id, toolCall = { toolCallId = tool, title = "Tool", kind = "other", status = "pending" },
            options = { { optionId = "allow", name = "Allow", kind = "allow_once" } },
            _meta = { agency = { version = 1, binding = vim.deepcopy(binding), requestId = id } },
        } })
    end
    local function answers(id)
        local found = {}
        for _, frame in ipairs(f.frames) do
            if frame.id == id and frame.result then found[#found + 1] = frame.result end
        end
        return found
    end
    local function count_requests(manager)
        local counter, add = { n = 0 }, manager.permission_manager.add_request
        manager.permission_manager.add_request = function(self, ...)
            counter.n = counter.n + 1
            return add(self, ...)
        end
        return counter
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
        assert.is_true(#renders < #expected)
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

    it("notifies when an Agency session asks for permission", function()
        local home, saved = vim.fn.tempname(), vim.env.HOME
        local record = home .. "/record"
        vim.fn.mkdir(home .. "/.claude/hooks", "p")
        vim.fn.writefile({ "#!/bin/sh", "printf '%s|%s' \"$NOTIFY_AGENT_NAME\" \"$NOTIFY_REASON\" > " .. vim.fn.shellescape(record) }, home .. "/.claude/hooks/notify-on-idle.sh")
        vim.fn.setfperm(home .. "/.claude/hooks/notify-on-idle.sh", "rwx------")
        vim.env.HOME = home
        local ok, err = pcall(function()
            f.client:_handle_message({ id = "notify-permission", method = "session/request_permission", params = {
                sessionId = f.manager.session_id, toolCall = { toolCallId = "notify-tool", title = "Tool", kind = "other", status = "pending" },
                options = { { optionId = "allow", name = "Allow", kind = "allow_once" } },
                _meta = { agency = { version = 1, binding = vim.deepcopy(f.manager._agency_binding) } },
            } })
            f.flush()
            assert.is_true(vim.wait(3000, function() return vim.fn.filereadable(record) == 1 and #vim.fn.readfile(record) > 0 end, 20))
            assert.are.equal("Agent|needs permission", vim.fn.readfile(record)[1])
        end)
        vim.env.HOME = saved
        vim.fn.delete(home, "rf")
        if not ok then error(err, 0) end
    end)

    it("shows a permission offered before the load reply once the binding is adopted", function()
        local manager = require("sodium.agency.agentic").open(control.agent(control.target_b))
        f.flush()
        local frame, shown = f.request("session/load"), count_requests(manager)
        permission("early", frame.params.sessionId, control.target_b, "early-tool")
        f.flush()
        f.client:_handle_message({ id = frame.id, result = { sessionId = frame.params.sessionId,
            _meta = { agency = { version = 1, binding = control.target_b, backendId = "codex-acp",
                configuration = { configOptions = {}, availableCommands = {} } } } } })
        f.flush()
        assert.are.equal(1, shown.n)
        assert.are.same({}, answers("early"))
        assert.are.equal("early", manager._agency_permissions["early-tool"])
    end)

    it("answers a permission from a superseded binding cancelled without showing it", function()
        local shown = count_requests(f.manager)
        local stale = vim.tbl_extend("force", f.manager._agency_binding, { providerGeneration = control.id(9) })
        permission("stale", f.manager.session_id, stale, "stale-tool")
        f.flush()
        assert.are.equal(0, shown.n)
        assert.are.same({ { outcome = { outcome = "cancelled" } } }, answers("stale"))
        assert.is_nil(writer.tool_call_blocks["stale-tool"])
    end)

    it("drops the live echo of this editor's admitted prompt", function()
        f.manager._agency_admissions = { own = {} }
        local function user(text, submission, replay)
            f.client:_handle_message({ method = "session/update", params = { sessionId = f.manager.session_id,
                update = { sessionUpdate = "user_message_chunk", content = { type = "text", text = text } },
                _meta = { agency = { version = 1, submissionId = submission, replay = replay } } } })
        end
        user("own live echo", "own", false)
        user("own replayed prompt", "own", true)
        user("other editor prompt", "other", false)
        f.flush()
        local text = buffer_text()
        assert.is_nil(text:find("own live echo", 1, true))
        assert.is_truthy(text:find("own replayed prompt", 1, true))
        assert.is_truthy(text:find("other editor prompt", 1, true))
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

    it("finishes attachment when fast transport callbacks reenter a retained replay", function()
        local manager = require("sodium.agency.agentic").open(control.agent(control.target_b))
        f.flush()
        local frame = f.request("session/load")
        local id, handlers, target = frame.params.sessionId, f.client.subscribers[frame.params.sessionId], manager.message_writer
        local write, injected, delivered, failure = target.write_message_chunk, false, nil, nil
        target.write_message_chunk = function(self, update)
            local result = write(self, update)
            if not injected then
                injected = true
                local done, timer = false, assert(vim.uv.new_timer())
                timer:start(0, 0, function()
                    timer:stop(); timer:close()
                    delivered, failure = pcall(function()
                        assert.is_true(vim.in_fast_event())
                        f.client:_handle_message({ method = "session/update", params = { sessionId = id,
                            update = { sessionUpdate = "tool_call", toolCallId = "live", title = "live tool", kind = "other", status = "pending" } } })
                        f.client:_handle_message({ id = frame.id, result = { sessionId = id,
                            _meta = { agency = { version = 1, binding = control.target_b, backendId = "codex-acp",
                                configuration = { configOptions = {}, availableCommands = {} } } } } })
                    end)
                    done = true
                end)
                assert.is_true(vim.wait(1000, function() return done end))
            end
            return result
        end
        for _, update in ipairs({ chunk("reentrant first\nreentrant second", { sessionUpdate = "agent_thought_chunk" }), chunk("reentrant answer") }) do
            f.client:_handle_message({ method = "session/update", params = { sessionId = id, update = update, _meta = { agency = { replay = true } } } })
        end
        f.flush()
        assert.is_true(injected)
        assert.is_true(delivered, failure)
        assert.is_nil(f.client.callbacks[frame.id])
        assert.are.equal(id, manager.session_id)
        assert.are.equal(handlers, f.client.subscribers[id])
        assert.are.same(control.target_b, manager._agency_binding)
        local lines, first, answer, live = vim.api.nvim_buf_get_lines(target.bufnr, 0, -1, false), nil, nil, nil
        for index, text in ipairs(lines) do
            if text:find("reentrant first", 1, true) then first = index end
            if text:find("reentrant answer", 1, true) then answer = index end
            if text:find("live tool", 1, true) then live = index end
        end
        assert.is_true(first < answer and answer < live)
        vim.api.nvim_win_call(manager.widget.win_nrs.chat, function()
            assert.are.equal(first, vim.fn.foldclosed(first))
            assert.are.equal(first + 1, vim.fn.foldclosedend(first))
        end)
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
        deliver(chunk(string.rep("older line\n", 100)))
        f.flush()
        deliver(chunk("new line\n"))
        vim.api.nvim_win_set_cursor(f.manager.widget.win_nrs.chat, { 2, 0 })
        f.flush()
        assert.are.equal(2, vim.api.nvim_win_get_cursor(f.manager.widget.win_nrs.chat)[1])
        assert.is_truthy(buffer_text():find("new line", 1, true))
    end)

    it("runs the completion hook when a turn this editor did not start ends, and not for its own turn", function()
        local calls = {}
        require("agentic.config").hooks = { on_response_complete = function(data) calls[#calls + 1] = data end }
        local binding = vim.deepcopy(f.manager._agency_binding)
        local function state(value, turn)
            f.client:_handle_message({ method = "agency/session_state", params = {
                sessionId = f.manager.session_id, binding = binding, state = value, turnId = turn } })
        end
        state("running", "00000000-0000-4000-8000-0000000000aa")
        state("idle", vim.NIL)
        assert.is_true(vim.wait(1000, function() return #calls == 1 end, 10))
        assert.are.equal(f.manager.session_id, calls[1].session_id)
        f.manager._agency_local_submission = "00000000-0000-4000-8000-0000000000bb"
        state("running", "00000000-0000-4000-8000-0000000000bb")
        state("idle", vim.NIL)
        vim.wait(200, function() return false end, 10)
        assert.are.equal(1, #calls)
    end)
end)