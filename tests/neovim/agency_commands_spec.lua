package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
local fixture = require("fixtures.agency")

describe("Agency editor commands", function()
    local f
    before_each(function()
        f = fixture.commands()
    end)
    after_each(function()
        f.close()
    end)
    local function attach()
        f.agency.current()
        local row = fixture.agent(fixture.target_a)
        row.record.definition.cwd = vim.fn.getcwd()
        f.respond(1, fixture.page({ row }))
        f.snapshot(1)
    end
    it("sets up and opens without Handler or provider work", function()
        assert.are.equal(0, #f.calls)
        f.agency.open()
        assert.are.equal(0, #f.calls)
        assert.are.equal(0, #f.streams)
        assert.is_truthy(vim.api.nvim_get_commands({}).AgencyCurrent)
    end)
    it("opens the exact returned attachment and shares it across tabs", function()
        attach()
        local view = f.agency.view_for_buffer(vim.api.nvim_get_current_buf())
        assert.is_truthy(view)
        assert.are.equal("/work/a", view.status().cwd)
        vim.cmd.tabnew()
        f.agency.open()
        assert.is_truthy(f.agency.view_for_buffer(vim.api.nvim_get_current_buf()))
        assert.are.equal(1, #f.streams)
        assert.are.equal(1, #f.calls)
        vim.cmd.tabclose()
        assert.is_false(f.streams[1].closed)
    end)
    it("has a pure lookup for native and ordinary buffers", function()
        assert.is_nil(f.agency.view_for_buffer(vim.api.nvim_get_current_buf()))
        vim.bo.filetype = "AgenticChat"
        assert.is_nil(f.agency.view_for_buffer(vim.api.nvim_get_current_buf()))
        vim.bo.filetype = ""
        assert.are.equal(0, #f.calls)
    end)
    it("draws Agency metadata without creating native providers", function()
        attach()
        local view = f.agency.view_for_buffer(vim.api.nvim_get_current_buf())
        for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
            if vim.api.nvim_win_get_buf(win) == view.widget.buf_nrs.chat then
                vim.api.nvim_set_current_win(win)
                break
            end
        end
        local old = package.loaded["agentic.session_registry"]
        package.loaded["agentic.session_registry"] = {
            sessions = {},
            get_session_for_tab_page = function()
                error("unexpected creating lookup")
            end,
        }
        local line = require("sodium.statusline")
        local ok, err = pcall(function()
            assert.are.equal("model-a", line.get_agentic_model())
            assert.are.equal("", line.get_agentic_context())
            assert.are.equal("Agency Chat", line.get_agentic_title())
        end)
        package.loaded["agentic.session_registry"] = old
        assert.is_true(ok, err)
        assert.are.equal(1, #f.calls)
    end)
    it("keeps the draft on direct review submission and sends only once", function()
        attach()
        local view = f.agency.view_for_buffer(vim.api.nvim_get_current_buf())
        vim.api.nvim_buf_set_lines(view.widget.buf_nrs.input, 0, -1, false, { "unsent draft" })
        local result
        f.agency.submit_text("review command", {}, function(value)
            result = value
        end)
        local request = f.streams[1].requests[1]
        assert.are.equal("review command", request.body.text)
        request.callback(nil, { receipt = { submissionId = fixture.id(900), state = "accepted" } })
        assert.are.equal("accepted", result.state)
        assert.are.same({ "unsent draft" }, vim.api.nvim_buf_get_lines(view.widget.buf_nrs.input, 0, -1, false))
    end)
    it("blocks a second direct submission after unknown delivery", function()
        attach()
        f.agency.submit_text("first", {})
        f.streams[1].requests[1].callback({ code = "UNAVAILABLE" })
        local result
        f.agency.submit_text("second", {}, function(value)
            result = value
        end)
        assert.are.equal("rejected", result.state)
        assert.are.equal(1, #f.streams[1].requests)
    end)
    it("cancels the observed turn rather than a subsequent submission", function()
        attach()
        local active = f.operations.attachment()
        local event = { kind = "turn", seq = 2, encodedBytes = 128, submissionId = fixture.id(901), state = "running" }
        active.state.apply_event({ target = fixture.target_a, event = event, firstSeq = 1, historyTruncated = false })
        f.agency.cancel()
        assert.are.same({ op = "cancel", submissionId = fixture.id(901) }, f.streams[1].requests[1].body)
    end)
    it("requires draft confirmation before replacing a target", function()
        attach()
        local view = f.agency.view_for_buffer(vim.api.nvim_get_current_buf())
        vim.api.nvim_buf_set_lines(view.widget.buf_nrs.input, 0, -1, false, { "draft" })
        f.agency.new()
        assert.are.equal(1, #f.switches)
        f.switches[1](false)
        assert.are.equal(1, #f.calls)
        assert.is_false(f.streams[1].closed)
    end)
    it("detaches without stop or cancel and removes buffer lookups", function()
        attach()
        local buf = vim.api.nvim_get_current_buf()
        f.agency.detach()
        assert.is_true(f.streams[1].closed)
        assert.are.equal(0, #f.streams[1].requests)
        assert.are.equal(1, #f.calls)
        assert.is_nil(f.agency.view_for_buffer(buf))
    end)
    it("rejects malformed command argument counts without lifecycle work", function()
        assert.has_error(function()
            vim.cmd("AgencyAttach")
        end)
        assert.has_error(function()
            vim.cmd("AgencyNew extra")
        end)
        assert.are.equal(0, #f.calls)
    end)
    it("ignores a superseded attach inventory callback", function()
        f.agency.attach(fixture.target_a.agentId)
        f.agency.current()
        f.respond(1, fixture.page({ fixture.agent(fixture.target_a) }))
        assert.are.equal(0, #f.streams)
    end)
    it("never attaches after the origin tab closes", function()
        vim.cmd.tabnew()
        f.agency.attach(fixture.target_a.agentId)
        vim.cmd.tabclose()
        f.respond(1, fixture.page({ fixture.agent(fixture.target_a) }))
        assert.are.equal(0, #f.streams)
    end)
    it("preserves annotation threads changed after capture", function()
        attach()
        local old = package.loaded["comment-overlay.store"]
        local thread = { { id = "root", body = "original", line = 1 } }
        local deletes = 0
        package.loaded["comment-overlay.store"] = {
            reload_if_changed = function() end,
            get_project_root = function()
                return "/work/a"
            end,
            get_files_with_comments = function()
                return { "file.lua" }
            end,
            get_for_file = function()
                return { thread[1] }
            end,
            get_thread = function()
                return vim.deepcopy(thread)
            end,
            delete = function()
                deletes = deletes + 1
            end,
        }
        local ok, err = pcall(function()
            f.agency.submit_text("annotations", { annotations = true })
            assert.are.equal(0, deletes)
            thread[#thread + 1] = { id = "reply", body = "later reply" }
            f.streams[1].requests[1].callback(nil, { receipt = { submissionId = fixture.id(900), state = "accepted" } })
            assert.are.equal(0, deletes)
            f.agency.submit_text("annotations", { annotations = true })
            f.streams[1].requests[2].callback(nil, { receipt = { submissionId = fixture.id(900), state = "accepted" } })
            assert.are.equal(1, deletes)
        end)
        package.loaded["comment-overlay.store"] = old
        assert.is_true(ok, err)
    end)
    it("notifies once per live completion across tab views", function()
        attach()
        vim.cmd.tabnew()
        f.agency.open()
        local event =
            { kind = "turn", seq = 2, encodedBytes = 128, submissionId = fixture.id(905), state = "completed" }
        local frame =
            { type = "event", target = fixture.target_a, event = event, firstSeq = 1, historyTruncated = false }
        f.streams[1].handlers.on_frame(frame, 256)
        f.streams[1].handlers.on_frame(frame, 256)
        assert.are.same({ "turn completed" }, f.notices)
        vim.cmd.tabclose()
    end)
    it("keeps status lookup free of disposal side effects", function()
        attach()
        local view = f.agency.view_for_buffer(vim.api.nvim_get_current_buf())
        local old = view.status
        local calls = 0
        view.status = function()
            calls = calls + 1
            return old()
        end
        f.agency.view_for_buffer(view.widget.buf_nrs.chat)
        assert.are.equal(0, calls)
        view.status = old
    end)
    it("toggles the pinned target despite cwd changes without querying inventory", function()
        attach()
        local view = f.agency.view_for_buffer(vim.api.nvim_get_current_buf())
        vim.api.nvim_buf_set_lines(view.widget.buf_nrs.input, 0, -1, false, { "draft" })
        local old = vim.fn.getcwd()
        vim.cmd.lcd("/tmp")
        f.agency.current()
        assert.is_false(view.widget.is_open())
        assert.are.equal(1, #f.calls)
        assert.are.equal(0, #f.switches)
        vim.cmd.lcd(old)
    end)
    it("reads status from cached metadata without copying the retained transcript", function()
        attach()
        local view = f.agency.view_for_buffer(vim.api.nvim_get_current_buf())
        local active = f.operations.attachment()
        local old = active.state.current
        active.state.current = function()
            error("unexpected transcript copy")
        end
        local ok, result = pcall(view.status)
        active.state.current = old
        assert.is_true(ok, result)
        assert.are.equal("model-a", result.model)
    end)
    it("does not send annotation prompts when no unresolved annotations exist", function()
        attach()
        local old = package.loaded["comment-overlay.store"]
        package.loaded["comment-overlay.store"] = {
            reload_if_changed = function() end,
            get_project_root = function()
                return "/work/a"
            end,
            get_files_with_comments = function()
                return {}
            end,
        }
        local result
        f.agency.submit_text("annotations", { annotations = true }, function(value)
            result = value
        end)
        package.loaded["comment-overlay.store"] = old
        assert.are.equal("rejected", result.state)
        assert.are.equal(0, #f.streams[1].requests)
    end)
    it("recovers unknown delivery only by inspecting the retained submission identity", function()
        attach()
        f.agency.submit_text("first", {})
        f.streams[1].requests[1].callback({ code = "UNAVAILABLE" })
        vim.cmd("AgencyInspect")
        assert.are.same({ op = "inspect-submission", submissionId = fixture.id(900) }, f.streams[1].requests[2].body)
        f.streams[1].requests[2].callback(nil, { receipt = { submissionId = fixture.id(900), state = "completed" } })
        f.agency.submit_text("next", {})
        assert.are.equal(3, #f.streams[1].requests)
    end)
    it("settles captured annotations exactly once when inspection proves unknown delivery accepted", function()
        f.close()
        local captured = { { text = "captured annotation", path = "/work/a/file.lua", revision = 1 } }
        local cleared = {}
        f = fixture.commands({
            annotations = function()
                return captured
            end,
            accept_annotations = function(value)
                cleared[#cleared + 1] = vim.deepcopy(value)
            end,
        })
        attach()
        f.agency.submit_text("annotations", { annotations = true })
        f.streams[1].requests[1].callback({ code = "UNAVAILABLE" })
        assert.are.equal(0, #cleared)
        vim.cmd("AgencyInspect")
        f.streams[1].requests[2].callback(nil, { receipt = { submissionId = fixture.id(900), state = "completed" } })
        assert.are.same({ captured }, cleared)
        f.streams[1].requests[1].callback(nil, { receipt = { submissionId = fixture.id(900), state = "accepted" } })
        assert.are.equal(1, #cleared)
    end)
    it("refuses a ready roster row replaced before selection dispatch", function()
        local displayed = fixture.agent(fixture.target_a)
        f.agency.attach(fixture.target_a.agentId, nil, displayed)
        local replacement = fixture.agent(fixture.target_a)
        replacement.record.launch.providerGeneration = fixture.id(906)
        f.respond(1, fixture.page({ replacement }))
        assert.are.equal(0, #f.streams)
    end)
    it("permits explicit new despite the existing attachment", function()
        attach()
        f.agency.new()
        assert.are.same({ "status" }, f.calls[2].argv)
        assert.are.equal(2, #f.calls)
    end)
    it("rejects delayed view confirmation after the captured target is replaced", function()
        f.close()
        local confirm
        f = fixture.commands({ confirm_external = function(_, _, done) confirm = done end })
        attach()
        local view = f.agency.view_for_buffer(vim.api.nvim_get_current_buf())
        vim.api.nvim_buf_set_lines(view.widget.buf_nrs.input, 0, -1, false, { "captured for A" })
        local result
        view.submit(function(value) result = value end)
        f.operations.attach(fixture.target_b, function() end)
        f.snapshot(2)
        confirm(true)
        assert.are.equal(0, #f.streams[2].requests)
        assert.are.equal("rejected", result.state)
        assert.are.same({ "captured for A" }, vim.api.nvim_buf_get_lines(view.widget.buf_nrs.input, 0, -1, false))
    end)
    it("does not inspect an old view submission through the replacement target", function()
        attach()
        local view = f.agency.view_for_buffer(vim.api.nvim_get_current_buf())
        vim.api.nvim_buf_set_lines(view.widget.buf_nrs.input, 0, -1, false, { "unknown for A" })
        view.submit(function() end)
        f.streams[1].requests[1].callback({ code = "UNAVAILABLE" })
        f.operations.attach(fixture.target_b, function() end)
        f.snapshot(2)
        local err
        view.inspect(function(value) err = value end)
        assert.are.equal(0, #f.streams[2].requests)
        assert.are.equal("NOT_READY", err and err.code)
        assert.are.equal("unknown", view.status().delivery)
    end)
    it("does not reconcile an old submission from a replacement tuple", function()
        attach()
        local view = f.agency.view_for_buffer(vim.api.nvim_get_current_buf())
        vim.api.nvim_buf_set_lines(view.widget.buf_nrs.input, 0, -1, false, { "unknown for A" })
        view.submit(function() end)
        f.streams[1].requests[1].callback({ code = "UNAVAILABLE" })
        f.operations.attach(fixture.target_b, function() end)
        f.snapshot(2)
        f.streams[2].handlers.on_frame({ type = "event", target = fixture.target_b,
            event = { kind = "turn", seq = 2, encodedBytes = 128, submissionId = fixture.id(900), state = "completed" },
            firstSeq = 1, historyTruncated = false }, 256)
        assert.are.equal("unknown", view.status().delivery)
        assert.are.same({ "unknown for A" }, vim.api.nvim_buf_get_lines(view.widget.buf_nrs.input, 0, -1, false))
    end)
    it("does not inspect an old direct submission through the replacement target", function()
        attach()
        f.agency.submit_text("unknown for A", {})
        f.streams[1].requests[1].callback({ code = "UNAVAILABLE" })
        f.operations.attach(fixture.target_b, function() end)
        f.snapshot(2)
        vim.cmd("AgencyInspect")
        assert.are.equal(0, #f.streams[2].requests)
    end)
    for _, mode in ipairs({ "view", "direct" }) do
        it("keeps " .. mode .. " submission retryable after a validated busy rejection", function()
            f.close()
            local transport = fixture.client()
            f = fixture.commands(nil, transport.client)
            local close = f.close
            f.close = function() close() transport.close() end
            f.operations.attach(fixture.target_a, function() end)
            transport.deliver(1, fixture.snapshot())
            f.agency.open()
            local view = f.agency.view_for_buffer(vim.api.nvim_get_current_buf())
            vim.api.nvim_buf_set_lines(view.widget.buf_nrs.input, 0, -1, false, { "retryable draft" })
            local result
            local function submit()
                if mode == "view" then
                    view.submit(function(value) result = value end)
                else
                    f.agency.submit_text("review command", {}, function(value) result = value end)
                end
            end
            submit()
            local request = vim.json.decode(transport.jobs[1].writes[1])
            transport.deliver(1, { { protocol = "agency-attachment/1", type = "response",
                target = fixture.target_a, requestId = request.requestId, ok = false,
                error = { code = "INCOMPLETE", message = "another turn is active" } } })
            assert.are.equal("rejected", result.state)
            assert.are.same({ "retryable draft" }, vim.api.nvim_buf_get_lines(view.widget.buf_nrs.input, 0, -1, false))
            submit()
            assert.are.equal(2, #transport.jobs[1].writes)
        end)
    end
    for _, choice in ipairs({ "Keep draft", "Include" }) do
        it("confirms outside annotations captured by normal view submit before " .. choice, function()
            f.close()
            f = fixture.commands({ confirm_external = require("sodium.agency.context").confirm_external })
            attach()
            local old_store, old_select = package.loaded["comment-overlay.store"], vim.ui.select
            local project, deletes, picker = "/other", 0, nil
            local thread = { { id = "root", body = "captured annotation", line = 1 } }
            package.loaded["comment-overlay.store"] = {
                reload_if_changed = function() end,
                get_project_root = function() return project end,
                get_files_with_comments = function() return { "file.lua" } end,
                get_for_file = function() return vim.deepcopy(thread) end,
                get_thread = function() return vim.deepcopy(thread) end,
                delete = function() deletes = deletes + 1 end,
            }
            vim.ui.select = function(_, options, callback)
                picker = { options = options, callback = callback }
            end
            local ok, err = pcall(function()
                local view = f.agency.view_for_buffer(vim.api.nvim_get_current_buf())
                view.submit(function() end)
                assert.is_truthy(picker)
                assert.is_truthy(picker.options.prompt:find("/other/file.lua", 1, true))
                assert.are.equal(0, #f.streams[1].requests)
                project = "/later"
                thread[1].body = "edited annotation"
                picker.callback(choice)
                if choice == "Include" then
                    local request = f.streams[1].requests[1]
                    assert.is_truthy(request.body.text:find("captured annotation", 1, true))
                    assert.is_nil(request.body.text:find("edited annotation", 1, true))
                    request.callback(nil, { receipt = { submissionId = fixture.id(900), state = "accepted" } })
                else
                    assert.are.equal(0, #f.streams[1].requests)
                    assert.are.equal("rejected", view.status().delivery)
                end
                assert.are.equal(0, deletes)
            end)
            package.loaded["comment-overlay.store"], vim.ui.select = old_store, old_select
            assert.is_true(ok, err)
        end)
    end
    it("restores the retained agent after ensuring a Handler absent after reboot", function()
        local result
        f.agency.restore(fixture.target_a.agentId, function(err) result = err end)
        f.respond(1, nil, { code = "UNAVAILABLE" })
        assert.are.equal(2, #f.calls)
        assert.are.same({ "status" }, f.calls[2].argv)
        f.respond(2, { phase = "ready" }, nil, fixture.target_b.handlerGeneration)
        local row = fixture.agent(fixture.target_a, "stopped")
        row.cleanup = "verified"
        f.respond(3, fixture.page({ row }), nil, fixture.target_b.handlerGeneration)
        assert.are.same({ "status" }, f.calls[4].argv)
        f.respond(4, { phase = "ready" }, nil, fixture.target_b.handlerGeneration)
        assert.are.same({ "agent", "restore", fixture.target_a.agentId }, vim.list_slice(f.calls[5].argv, 1, 3))
        assert.is_true(vim.tbl_contains(f.calls[5].argv, "--expected-handler-generation"))
        local restored = vim.deepcopy(fixture.target_b)
        restored.agentId = fixture.target_a.agentId
        f.respond(5, fixture.command(restored, "restored"), nil, fixture.target_b.handlerGeneration)
        f.snapshot(1)
        assert.is_nil(result)
        assert.are.same(restored, f.operations.attachment().target)
    end)
end)