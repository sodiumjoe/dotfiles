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
        local manager = require("sodium.agency").open(control.agent(control.target_b))
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

    it("answers cancelled once when the stream flush before a permission throws", function()
        local Stream, notify, notices = require("sodium.agency.stream"), vim.notify, {}
        local flush = Stream.flush
        Stream.flush = function() error("injected flush failure") end
        vim.notify = function(message) notices[#notices + 1] = message end
        local ok, err = pcall(function()
            permission("broken", f.manager.session_id, f.manager._agency_binding, "broken-tool")
            f.flush()
        end)
        Stream.flush, vim.notify = flush, notify
        assert.is_true(ok, err)
        assert.are.same({ { outcome = { outcome = "cancelled" } } }, answers("broken"))
        assert.is_truthy(table.concat(notices, "\n"):find("injected flush failure", 1, true))
    end)

    it("still shows a permission when the flush before its delivery throws", function()
        local Stream, notify, calls, shown = require("sodium.agency.stream"), vim.notify, 0, count_requests(f.manager)
        local flush = Stream.flush
        Stream.flush = function(...)
            calls = calls + 1
            if calls == 2 then error("injected flush failure") end
            return flush(...)
        end
        vim.notify = function() end
        local ok, err = pcall(function()
            permission("delivered", f.manager.session_id, f.manager._agency_binding, "delivered-tool")
            f.flush()
        end)
        Stream.flush, vim.notify = flush, notify
        assert.is_true(ok, err)
        assert.are.equal(2, calls)
        assert.are.equal(1, shown.n)
        assert.are.same({}, answers("delivered"))
    end)

    it("answers every held permission when one offer fails", function()
        local manager = require("sodium.agency").open(control.agent(control.target_b))
        f.flush()
        local frame, shown = f.request("session/load"), count_requests(manager)
        permission("first", frame.params.sessionId, control.target_b, "first-tool")
        permission("second", frame.params.sessionId, control.target_b, "second-tool")
        f.flush()
        local Stream, notify, failed = require("sodium.agency.stream"), vim.notify, false
        local flush = Stream.flush
        Stream.flush = function(...)
            if not failed then
                failed = true
                error("injected flush failure")
            end
            return flush(...)
        end
        vim.notify = function() end
        local ok, err = pcall(function()
            f.client:_handle_message({ id = frame.id, result = { sessionId = frame.params.sessionId,
                _meta = { agency = { version = 1, binding = control.target_b, backendId = "codex-acp",
                    configuration = { configOptions = {}, availableCommands = {} } } } } })
            f.flush()
        end)
        Stream.flush, vim.notify = flush, notify
        assert.is_true(ok, err)
        assert.are.same({ { outcome = { outcome = "cancelled" } } }, answers("first"))
        assert.are.same({}, answers("second"))
        assert.are.equal(1, shown.n)
        assert.are.equal("second", manager._agency_permissions["second-tool"])
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
        local manager = require("sodium.agency").open(control.agent(control.target_b))
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

    local function replayed(id, update)
        f.client:_handle_message({ method = "session/update", params = { sessionId = id, update = update, _meta = { agency = { replay = true } } } })
    end
    local function lines_of(manager)
        return vim.api.nvim_buf_get_lines(manager.message_writer.bufnr, 0, -1, false)
    end

    it("names the backend in replayed headers before the load reply arrives", function()
        local row = control.agent(control.target_b)
        row.record.definition.backendId = "claude-agent-acp"
        local manager = require("sodium.agency").open(row)
        f.flush()
        replayed(f.request("session/load").params.sessionId, chunk("restored answer"))
        f.flush()
        local text = table.concat(lines_of(manager), "\n")
        assert.is_truthy(text:find("Agent - claude-agent-acp", 1, true))
        assert.is_nil(text:find("Agent - Agency", 1, true))
    end)

    it("names the backend in a reattached session's replayed headers", function()
        local row = control.agent(control.target_a)
        row.record.definition.backendId = "claude-agent-acp"
        local target = require("sodium.agency.rebind").reattach(f.manager, row)
        f.flush()
        replayed(f.request("session/load").params.sessionId, chunk("restored answer"))
        f.flush()
        local text = table.concat(lines_of(target), "\n")
        assert.is_truthy(text:find("Agent - claude-agent-acp", 1, true))
        assert.is_nil(text:find("Agent - Agency", 1, true))
    end)

    it("separates adjacent agent messages and keeps one message's chunks together", function()
        local id = f.manager.session_id
        replayed(id, chunk("ok", { messageId = "m1" }))
        replayed(id, chunk("Config warning: unknown key\n\n"))
        replayed(id, chunk("fi", { messageId = "m2" }))
        replayed(id, chunk("ne", { messageId = "m2" }))
        f.flush()
        deliver(chunk("al", { messageId = "m3" }))
        f.flush()
        deliver(chunk("pha", { messageId = "m3" }))
        f.flush()
        local lines = lines_of(f.manager)
        local at
        for index, text in ipairs(lines) do
            if text == "ok" then at = index end
        end
        assert.is_truthy(at)
        assert.are.same({ "ok", "", "Config warning: unknown key", "", "fine", "", "alpha" }, vim.list_slice(lines, at, at + 6))
        local warnings = 0
        for _, text in ipairs(lines) do
            if text:find("Config warning", 1, true) then warnings = warnings + 1 end
        end
        assert.are.equal(1, warnings)
    end)

    it("keeps one blank line before a message that brings its own leading newlines", function()
        local id = f.manager.session_id
        replayed(id, chunk("ok", { messageId = "m1" }))
        replayed(id, chunk("\n\n> Notice text\n\n"))
        replayed(id, chunk("next", { messageId = "m2" }))
        f.flush()
        local lines = lines_of(f.manager)
        local at
        for index, text in ipairs(lines) do
            if text == "ok" then at = index end
        end
        assert.is_truthy(at)
        assert.are.same({ "ok", "", "> Notice text", "", "next" }, vim.list_slice(lines, at, at + 4))
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
        assert.are.equal(f.manager.session_key, calls[1].session_key)
    end)

    local function withdraw(session_id, binding, id, tool)
        f.client:_handle_message({ method = "agency/permission_withdrawn", params = {
            sessionId = session_id, binding = vim.deepcopy(binding), requestId = id, toolCallId = tool } })
    end
    local function input_lines()
        return vim.api.nvim_buf_get_lines(f.manager.widget.buf_nrs.input, 0, -1, false)
    end
    local function submit(lines)
        vim.api.nvim_buf_set_lines(f.manager.widget.buf_nrs.input, 0, -1, false, lines)
        f.manager.widget:_submit_input()
        return f.request("session/prompt")
    end
    local function controller()
        local api, calls = require("sodium.agency").setup(), { recovered = {}, resumed = 0 }
        api.recover = function(manager) calls.recovered[#calls.recovered + 1] = manager end
        api.resume = function() calls.resumed = calls.resumed + 1 end
        return calls
    end

    it("offers a held permission once a session state adopts the binding", function()
        local manager = require("sodium.agency").open(control.agent(control.target_b))
        f.flush()
        local id, shown = f.request("session/load").params.sessionId, count_requests(manager)
        permission("early", id, control.target_b, "early-tool")
        f.flush()
        assert.are.equal(0, shown.n)
        f.client:_handle_message({ method = "agency/session_state", params = { sessionId = id, binding = control.target_b, state = "idle" } })
        f.flush()
        assert.are.equal(1, shown.n)
        assert.are.same({}, answers("early"))
        assert.are.same(control.target_b, manager._agency_binding)
    end)

    it("drops a withdrawn permission whether it is held or shown", function()
        local manager = require("sodium.agency").open(control.agent(control.target_b))
        f.flush()
        local frame, shown = f.request("session/load"), count_requests(manager)
        local id = frame.params.sessionId
        permission("gone", id, control.target_b, "gone-tool")
        permission("kept", id, control.target_b, "kept-tool")
        f.flush()
        withdraw(id, control.target_b, "gone", "gone-tool")
        f.flush()
        f.client:_handle_message({ id = frame.id, result = { sessionId = id,
            _meta = { agency = { version = 1, binding = control.target_b, backendId = "codex-acp",
                configuration = { configOptions = {}, availableCommands = {} } } } } })
        f.flush()
        assert.are.equal(1, shown.n)
        assert.are.same({}, answers("gone"))
        assert.are.equal("kept", manager._agency_permissions["kept-tool"])
        withdraw(id, control.target_b, "kept", "kept-tool")
        f.flush()
        assert.is_nil(manager.permission_manager.pending["kept-tool"])
        assert.are.same({ { outcome = { outcome = "cancelled" } } }, answers("kept"))
    end)

    it("cancels the current turn by its id and sends nothing without one", function()
        f.manager.agent:stop_generation(f.manager.session_id)
        assert.has_error(function() f.request("session/cancel") end)
        f.state("turn-7", "running")
        f.manager.agent:stop_generation(f.manager.session_id)
        assert.are.same({ version = 1, turnId = "turn-7" }, f.request("session/cancel").params._meta.agency)
    end)

    it("restores the draft and context of a prompt rejected before admission", function()
        local calls, rejected = controller(), {}
        local file = vim.env.DOTFILES_TEST_ROOT .. "/README.md"
        local selection = { lines = { "local x = 1" }, start_line = 1, end_line = 1, file_path = "x.lua", file_type = "lua" }
        local scratch = vim.api.nvim_create_buf(false, true)
        vim.api.nvim_buf_set_lines(scratch, 0, -1, false, { "local x = 1" })
        local diagnostic = { bufnr = scratch, lnum = 0, col = 0, message = "broken", severity = 1, file_path = "/tmp/x.lua" }
        local entry = require("sodium.agency.context").stage(f.manager, { { type = "text", text = "staged context" } },
            function() end, function(err) rejected[#rejected + 1] = err end)
        f.manager._is_first_message = true
        f.manager.code_selection:add(selection)
        f.manager.file_list:add(file)
        f.manager.diagnostics_list:add_many({ diagnostic })
        local frame = submit({ "first line", "second line" })
        assert.are.equal(f.manager._agency_local_submission, frame.params._meta.agency.submissionId)
        assert.are.equal("staged context", frame.params.prompt[#frame.params.prompt].text)
        assert.are.same({ "" }, input_lines())
        assert.are.same({}, f.manager.file_list:get_files())
        f.client:_handle_message({ id = frame.id, error = { code = -32000, message = "refused" } })
        f.flush()
        assert.are.same({ "first line", "second line" }, input_lines())
        assert.are.same({ selection }, f.manager.code_selection:get_selections())
        assert.are.same({ file }, f.manager.file_list:get_files())
        assert.are.equal(1, #f.manager.diagnostics_list:get_diagnostics())
        assert.is_true(f.manager._is_first_message)
        assert.is_nil(entry.submission)
        assert.are.equal(1, #rejected)
        assert.are.same({ f.manager }, calls.recovered)
        assert.is_false(f.manager.is_generating)
        vim.api.nvim_buf_delete(scratch, { force = true })
    end)

    it("leaves the input untouched when a prompt is rejected under a binding it no longer holds", function()
        local calls = controller()
        f.manager.file_list:add(vim.env.DOTFILES_TEST_ROOT .. "/README.md")
        local frame = submit({ "question" })
        f.manager._agency_binding = vim.tbl_extend("force", f.manager._agency_binding, { providerGeneration = control.id(9) })
        f.client:_handle_message({ id = frame.id, error = { code = -32000, message = "refused" } })
        f.flush()
        assert.are.same({ "" }, input_lines())
        assert.are.same({}, f.manager.file_list:get_files())
        assert.are.same({}, calls.recovered)
    end)

    local function moved_row()
        local moved = vim.tbl_extend("force", control.target_a, { handlerGeneration = control.id(20), providerGeneration = control.id(21) })
        local row = control.agent(moved)
        row.record.definition.cwd = vim.fn.getcwd()
        return moved, row
    end
    local function answer_load(binding)
        local frame = f.request("session/load")
        f.client:_handle_message({ id = frame.id, result = { sessionId = frame.params.sessionId, _meta = { agency = { version = 1, binding = binding,
            backendId = "codex-acp", configuration = { configOptions = {}, availableCommands = {} } } } } })
        f.flush()
    end

    it("leaves the reattached view untouched when a rejection reaches the source the reattach replaced", function()
        local calls, source, rejected = controller(), f.manager, {}
        source.file_list:add(vim.env.DOTFILES_TEST_ROOT .. "/README.md")
        local entry = require("sodium.agency.context").stage(source, { { type = "text", text = "staged context" } },
            function() end, function(err) rejected[#rejected + 1] = err end)
        local frame = submit({ "question" })
        assert.are.equal(source._agency_local_submission, entry.submission)
        local moved, row = moved_row()
        local target = require("sodium.agency.rebind").reattach(source, row)
        f.flush()
        answer_load(moved)
        assert.is_true(source._destroyed)
        assert.are.same(control.target_a, source._agency_binding)
        f.client:_handle_message({ id = frame.id, error = { code = -32000, message = "refused" } })
        f.flush()
        assert.are.same({ "" }, vim.api.nvim_buf_get_lines(target.widget.buf_nrs.input, 0, -1, false))
        assert.are.same({}, target.file_list:get_files())
        assert.are.same({}, rejected)
        assert.are.same({}, calls.recovered)
    end)

    it("drops a source's queued replay batch once a reattach target owns the session id", function()
        local source, id = f.manager, f.manager.session_id
        local function replay(text)
            f.client:_handle_message({ method = "session/update", params = { sessionId = id, update = chunk(text), _meta = { agency = { replay = true } } } })
        end
        local moved, row = moved_row()
        local target = require("sodium.agency.rebind").reattach(source, row)
        replay("meant for the source")
        assert.are.equal(source.handlers, f.client.subscribers[id])
        assert.is_not_nil(source.handlers._agency_replay_batch)
        f.flush()
        assert.are.equal(target.handlers, f.client.subscribers[id])
        replay("meant for the target")
        f.flush()
        assert.are.same({}, renders)
        assert.is_falsy(buffer_text():find("meant for", 1, true))
        answer_load(moved)
        local shown = table.concat(vim.api.nvim_buf_get_lines(target.message_writer.bufnr, 0, -1, false), "\n")
        assert.is_truthy(shown:find("meant for the target", 1, true))
        assert.is_falsy(shown:find("meant for the source", 1, true))
    end)

    it("marks the session unavailable without an error message when the Handler disconnects during a prompt", function()
        local calls, finishes = controller(), 0
        local finish = writer.write_finish_message
        writer.write_finish_message = function(...)
            finishes = finishes + 1
            return finish(...)
        end
        submit({ "question" })
        assert.is_true(f.manager.is_generating)
        f.client.transport.process = {}
        f.client:_set_state("disconnected")
        f.client.transport.process = nil
        f.flush()
        assert.are.equal(0, finishes)
        assert.are.same({}, calls.recovered)
        assert.are.equal(1, calls.resumed)
        assert.is_false(f.manager.is_generating)
        assert.is_true(f.manager._agency_unavailable)
        assert.is_nil(f.manager._agency_binding)
        assert.are.same({ "" }, input_lines())
    end)

    it("leaves sessions available and does not resume after a deliberate stop", function()
        local calls = controller()
        f.client:_set_state("disconnected")
        f.flush()
        assert.is_nil(f.manager._agency_unavailable)
        assert.are.same(require("fixtures.agency_control").target_a, f.manager._agency_binding)
        assert.are.equal(0, calls.resumed)
    end)

    it("rejects and restores a prompt sent after the Handler disconnected", function()
        local calls, finishes, outcome = controller(), 0, nil
        local finish = writer.write_finish_message
        writer.write_finish_message = function(...)
            finishes = finishes + 1
            return finish(...)
        end
        f.client.transport.process = {}
        f.client:_set_state("disconnected")
        f.client.transport.process = nil
        f.flush()
        assert.is_true(f.manager._agency_unavailable)
        require("sodium.agency").setup().submit_text("retry", { session = f.manager.session_key }, function(value) outcome = value end)
        f.flush()
        assert.are.equal(1, finishes)
        assert.is_false(f.manager.is_generating)
        assert.is_nil(f.manager.status_animation._state)
        assert.are.same({ "retry" }, input_lines())
        assert.are.equal("rejected", outcome.state)
        assert.are.same({}, f.manager._agency_admissions)
        assert.are.same({ f.manager }, calls.recovered)
    end)

    it("renders buffered text before the user's own message", function()
        deliver(chunk("streamed before submit"))
        assert.is_true(vim.wait(100, function() return f.manager._agency_stream ~= nil end, 1))
        submit({ "question after" })
        f.flush()
        local text = buffer_text()
        assert.is_true(text:find("streamed before submit", 1, true) < text:find("question after", 1, true))
    end)
end)