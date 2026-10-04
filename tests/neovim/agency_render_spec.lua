package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path

describe("Agency bounded pinned MessageWriter", function()
    local fixture, renderer, widget, snapshot
    before_each(function()
        fixture = require("fixtures.agency")
        widget = require("sodium.agency.widget").new(vim.api.nvim_get_current_tabpage(), function() end)
        snapshot = fixture.projection()
        renderer = require("sodium.agency.render").new(widget, function()
            return snapshot
        end)
    end)
    after_each(function()
        renderer.destroy()
        widget.destroy()
    end)
    it("replays thought and text chunks exactly once", function()
        snapshot.events = {
            fixture.event(1, "answer"),
            fixture.update(
                2,
                { sessionUpdate = "agent_thought_chunk", content = { type = "text", text = "thinking" } }
            ),
        }
        snapshot.lastSeq = 2
        renderer.reset(snapshot)
        local lines = vim.api.nvim_buf_get_lines(widget.buf_nrs.chat, 0, -1, false)
        renderer.reset(snapshot)
        assert.are.same(lines, vim.api.nvim_buf_get_lines(widget.buf_nrs.chat, 0, -1, false))
        assert.is_truthy(table.concat(lines, "\n"):find("thinking", 1, true))
    end)
    it("normalizes tools and displays a partial block for orphan updates", function()
        renderer.reset(snapshot)
        local event = fixture.update(
            2,
            {
                sessionUpdate = "tool_call_update",
                toolCallId = "orphan",
                kind = "edit",
                status = "completed",
                title = "change",
                locations = { { path = "src/a.lua", line = 3 } },
                content = { { type = "diff", path = "src/a.lua", oldText = "old", newText = "new" } },
            }
        )
        snapshot.events[#snapshot.events + 1] = event
        snapshot.lastSeq = 2
        renderer.event(event, { replay = false })
        local block = renderer.writer.tool_call_blocks.orphan
        assert.are.equal("/work/a/src/a.lua", block.file_path)
        assert.are.same({ "old" }, block.diff.old)
        assert.are.same({ "new" }, block.diff.new)
        assert.is_truthy(block.argument:find("partial", 1, true))
        assert.are.equal("completed", block.status)
    end)
    it("renders plans without touching native headers or buffer names", function()
        vim.t.agentic_headers = { todos = { title = "native" } }
        local headers = vim.deepcopy(vim.t.agentic_headers)
        local name = vim.api.nvim_buf_get_name(widget.buf_nrs.todos)
        local event = fixture.update(
            2,
            { sessionUpdate = "plan", entries = { { content = "inspect", status = "in_progress", priority = "high" } } }
        )
        renderer.event(event, { replay = true })
        assert.are.same({ "[in_progress] inspect" }, vim.api.nvim_buf_get_lines(widget.buf_nrs.todos, 0, -1, false))
        assert.are.same(headers, vim.t.agentic_headers)
        assert.are.equal(name, vim.api.nvim_buf_get_name(widget.buf_nrs.todos))
    end)
    it("opens the first live plan panel without changing focus and closes an empty plan", function()
        widget.show({ focus_prompt = true })
        renderer.reset(snapshot)
        local focus = vim.api.nvim_get_current_win()
        local event = fixture.update(2, { sessionUpdate = "plan",
            entries = { { content = "inspect", status = "in_progress", priority = "high" } } })
        renderer.event(event)
        assert.is_truthy(widget.win_nrs.todos)
        assert.is_true(vim.api.nvim_win_is_valid(widget.win_nrs.todos))
        assert.are.equal(widget.buf_nrs.todos, vim.api.nvim_win_get_buf(widget.win_nrs.todos))
        assert.are.equal(focus, vim.api.nvim_get_current_win())
        renderer.event(fixture.update(3, { sessionUpdate = "plan", entries = {} }))
        assert.is_nil(widget.win_nrs.todos)
        assert.are.equal(focus, vim.api.nvim_get_current_win())
    end)
    it("opens a retained replay plan only while the view is visible", function()
        snapshot.metadata.plan = { { content = "retained", status = "pending", priority = "low" } }
        renderer.reset(snapshot)
        assert.is_false(widget.is_open())
        assert.is_nil(widget.win_nrs.todos)
        renderer.release()
        widget.show({ focus_prompt = true })
        assert.is_nil(widget.win_nrs.todos)
        local focus = vim.api.nvim_get_current_win()
        renderer.reset(snapshot)
        assert.is_truthy(widget.win_nrs.todos)
        assert.are.same({ "[pending] retained" }, vim.api.nvim_buf_get_lines(widget.buf_nrs.todos, 0, -1, false))
        assert.are.equal(focus, vim.api.nvim_get_current_win())
    end)
    it("preserves every diff in a multi-file tool update", function()
        local event = fixture.update(2, {
            sessionUpdate = "tool_call",
            toolCallId = "multi-diff",
            title = "change two files",
            kind = "edit",
            status = "completed",
            content = {
                { type = "diff", path = "first.lua", oldText = "before-first", newText = "after-first" },
                { type = "diff", path = "second.lua", oldText = "before-second", newText = "after-second" },
            },
        })
        renderer.reset(snapshot)
        renderer.event(event)
        local text = table.concat(vim.api.nvim_buf_get_lines(widget.buf_nrs.chat, 0, -1, false), "\n")
        for _, value in ipairs({ "first.lua", "before-first", "after-first", "second.lua", "before-second", "after-second" }) do
            assert.is_truthy(text:find(value, 1, true), value)
        end
    end)
    it("keeps an oversized-event summary valid UTF-8 under a tiny byte budget", function()
        renderer.destroy()
        for budget = 75, 85 do
            renderer = require("sodium.agency.render").new(widget, function()
                return snapshot
            end, { text_bytes = budget })
            snapshot.events = { fixture.update(2, {
                sessionUpdate = "tool_call",
                toolCallId = string.rep("🙂", 16),
                title = "large tool",
                kind = "execute",
                status = "completed",
                content = { { type = "content", content = { type = "text", text = string.rep("x", 512) } } },
            }) }
            snapshot.lastSeq = 2
            renderer.reset(snapshot)
            local text = table.concat(vim.api.nvim_buf_get_lines(widget.buf_nrs.chat, 0, -1, false), "\n")
            local encoded, err = require("sodium.agency.context").encode({ text = text }, {}, {}, {})
            assert.is_nil(err)
            assert.is_truthy(encoded)
            renderer.destroy()
        end
    end)
    for _, limit in ipairs({ "text_bytes", "lines", "tool_count", "tool_string_bytes" }) do
        it("enforces the " .. limit .. " budget on real writer state", function()
            renderer.destroy()
            local limits = { text_bytes = 65536, lines = 1000, tool_count = 64, tool_string_bytes = 65536 }
            limits[limit] = ({ text_bytes = 512, lines = 16, tool_count = 2, tool_string_bytes = 128 })[limit]
            renderer = require("sodium.agency.render").new(widget, function()
                return snapshot
            end, limits)
            renderer.reset(snapshot)
            for i = 2, 15 do
                local event = fixture.update(
                    i,
                    {
                        sessionUpdate = "tool_call",
                        toolCallId = "tool-" .. i,
                        title = "execute",
                        kind = "execute",
                        status = "in_progress",
                        content = { { type = "content", content = { type = "text", text = string.rep("x\n", 100) } } },
                    }
                )
                snapshot.events[#snapshot.events + 1] = event
                snapshot.lastSeq = i
                renderer.event(event, { replay = false })
                assert.is_true(renderer.metrics()[limit] <= limits[limit])
            end
        end)
    end
    it("summarizes one oversized event and releases all retained display state", function()
        renderer.destroy()
        renderer = require("sodium.agency.render").new(widget, function()
            return snapshot
        end, { text_bytes = 256, lines = 10, tool_count = 1, tool_string_bytes = 128 })
        snapshot.events = { fixture.event(1, string.rep("x", 10000)) }
        renderer.reset(snapshot)
        assert.is_truthy(
            table.concat(vim.api.nvim_buf_get_lines(widget.buf_nrs.chat, 0, -1, false), "\n"):find("event 1", 1, true)
        )
        renderer.release()
        assert.are.same({ text_bytes = 0, lines = 0, tool_count = 0, tool_string_bytes = 0 }, renderer.metrics())
        assert.is_nil(renderer.writer)
        assert.are.equal(0, #vim.api.nvim_buf_get_extmarks(widget.buf_nrs.chat, -1, 0, -1, {}))
    end)
    it("rebuilds from at most the newest 1024 tiny events", function()
        snapshot.events = {}
        for i = 1, 3000 do
            snapshot.events[i] = fixture.event(i, "x")
        end
        snapshot.lastSeq = 3000
        renderer.reset(snapshot)
        assert.are.equal(1977, renderer.renderFirstSeq)
        local text = table.concat(vim.api.nvim_buf_get_lines(widget.buf_nrs.chat, 0, -1, false), "\n")
        assert.is_truthy(text:find("history truncated", 1, true))
    end)
    it("compacts actual accumulated strings from repeated tool updates", function()
        renderer.destroy()
        renderer = require("sodium.agency.render").new(widget, function()
            return snapshot
        end, { tool_string_bytes = 512 })
        renderer.reset(snapshot)
        for i = 2, 50 do
            local event = fixture.update(
                i,
                {
                    sessionUpdate = i == 2 and "tool_call" or "tool_call_update",
                    toolCallId = "one",
                    title = "execute",
                    kind = "execute",
                    status = "in_progress",
                    content = {
                        { type = "content", content = { type = "text", text = tostring(i) .. string.rep("x", 100) } },
                    },
                }
            )
            snapshot.events[#snapshot.events + 1] = event
            snapshot.lastSeq = i
            renderer.event(event, { replay = false })
            assert.is_true(renderer.metrics().tool_string_bytes <= 512)
        end
    end)
    it("replays maximum-sized text and title without retaining the title payload", function()
        snapshot.events = {
            fixture.event(1, string.rep("α", 393216)),
            fixture.update(2, { sessionUpdate = "session_info_update", title = string.rep("t", 1040000) }),
        }
        snapshot.lastSeq = 2
        renderer.reset(snapshot)
        assert.is_true(renderer.metrics().text_bytes <= 4194304)
        assert.are.equal(0, renderer.metrics().tool_count)
    end)
end)