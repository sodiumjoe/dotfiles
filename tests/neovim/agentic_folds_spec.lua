package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
dofile(vim.env.DOTFILES_TEST_ROOT .. "/home/.config/nvim/lua/sodium/plugins/agentic.lua").config()

describe("Agentic completed block folding", function()
    local f, writer, saved_folding
    local function chunk(text, kind)
        return { sessionUpdate = kind or "agent_thought_chunk", content = { type = "text", text = text } }
    end
    local function line(text)
        for index, value in ipairs(vim.api.nvim_buf_get_lines(writer.bufnr, 0, -1, false)) do
            if value:find(text, 1, true) then return index end
        end
        error("Missing chat text: " .. text)
    end
    local function closed(lnum)
        return vim.api.nvim_win_call(f.manager.widget.win_nrs.chat, function()
            return { vim.fn.foldclosed(lnum), vim.fn.foldclosedend(lnum) }
        end)
    end
    local function thought(text)
        writer:write_message_chunk(chunk(text))
    end
    local function answer(text)
        writer:write_message_chunk(chunk(text or "answer", "agent_message_chunk"))
    end
    before_each(function()
        f = require("fixtures.agency_native").new()
        writer = f.manager.message_writer
        saved_folding = vim.deepcopy(require("agentic.config").folding)
    end)
    after_each(function()
        require("agentic.config").folding = saved_folding
        f.close()
    end)

    it("keeps thought chunks expanded until a response, then folds only their lines", function()
        thought("first thought\n")
        thought("second thought")
        local first = line("first thought")
        assert.are.same({ -1, -1 }, closed(first))
        answer()
        assert.are.same({ first, first + 1 }, closed(first))
        assert.are.same({ -1, -1 }, closed(line("answer")))
    end)

    it("folds a completed single-line thought", function()
        thought("short thought")
        answer()
        local first = line("short thought")
        assert.are.same({ first, first }, closed(first))
    end)

    it("folds thinking before tool output while leaving the active tool expanded", function()
        thought("before tool\nstill thinking")
        writer:write_tool_call_block({ tool_call_id = "active", kind = "execute", argument = "echo pending", status = "in_progress", body = { "pending output" } })
        local first = line("before tool")
        assert.are.same({ first, first + 1 }, closed(first))
        assert.are.same({ -1, -1 }, closed(line("pending output")))
    end)

    it("folds a thought-only native turn when its finish message is written", function()
        thought("native first\nnative second")
        writer:write_finish_message({ stopReason = "end_turn" })
        local first = line("native first")
        assert.are.same({ first, first + 1 }, closed(first))
        assert.are.same({ -1, -1 }, closed(line(require("agentic.config").message_icons.finished)))
    end)

    it("keeps separate completed thinking blocks distinct", function()
        thought("earlier first\nearlier second")
        answer("intermediate answer")
        thought("later first\nlater second")
        answer("final answer")
        for _, text in ipairs({ "earlier first", "later first" }) do
            local first = line(text)
            assert.are.same({ first, first + 1 }, closed(first))
        end
        assert.are.same({ -1, -1 }, closed(line("intermediate answer")))
        assert.are.same({ -1, -1 }, closed(line("final answer")))
    end)

    it("preserves manually opened thoughts when later output arrives and the widget reopens", function()
        thought("reopened first\nreopened second")
        answer()
        local first = line("reopened first")
        assert.are.same({ first, first + 1 }, closed(first))
        vim.api.nvim_win_call(f.manager.widget.win_nrs.chat, function()
            vim.cmd(first .. "foldopen")
        end)
        thought("another first\nanother second")
        answer("later answer")
        f.manager.widget:hide()
        f.manager.widget:show({ focus_prompt = false })
        assert.are.same({ -1, -1 }, closed(first))
        local later = line("another first")
        assert.are.same({ later, later + 1 }, closed(later))
    end)

    it("folds restored thinking including a trailing thought with no following message", function()
        writer:replay_history_messages({
            { type = "thought", text = "restored first\nrestored second" },
            { type = "agent", text = "restored answer" },
            { type = "thought", text = "restored trailing" },
        })
        local first, trailing = line("restored first"), line("restored trailing")
        assert.are.same({ first, first + 1 }, closed(first))
        assert.are.same({ trailing, trailing }, closed(trailing))
        assert.are.same({ -1, -1 }, closed(line("restored answer")))
    end)

    it("tracks pending thinking folds when an earlier tool block grows", function()
        writer:write_tool_call_block({ tool_call_id = "growing", kind = "execute", argument = "command", status = "in_progress", body = { "old" } })
        local apply = writer._apply_scroll
        writer._apply_scroll = function() end
        thought("shifted first\nshifted second")
        answer("shifted answer")
        writer:update_tool_call_block({ tool_call_id = "growing", body = { "new 1", "new 2", "new 3", "new 4" }, status = "in_progress" })
        writer._apply_scroll = nil
        apply(writer, writer.bufnr)
        local first = line("shifted first")
        assert.are.same({ first, first + 1 }, closed(first))
        assert.are.same({ -1, -1 }, closed(line("shifted answer")))
    end)

    it("tracks an active thinking range after an earlier tool grows", function()
        writer:write_tool_call_block({ tool_call_id = "growing", kind = "execute", argument = "command", status = "in_progress", body = { "old" } })
        thought("active shifted first\nactive shifted second")
        writer:update_tool_call_block({ tool_call_id = "growing", body = { "new 1", "new 2", "new 3", "new 4" }, status = "in_progress" })
        answer()
        local first = line("active shifted first")
        assert.are.same({ first, first + 1 }, closed(first))
    end)

    it("keeps active tool output expanded when thinking continues after that tool grows", function()
        writer:write_tool_call_block({ tool_call_id = "growing", kind = "execute", argument = "command", status = "in_progress", body = { "old" } })
        thought("continued first\ncontinued second")
        writer:update_tool_call_block({ tool_call_id = "growing", body = { "new 1", "new 2", "new 3", "new 4" }, status = "in_progress" })
        thought("\ncontinued third")
        answer()
        local first = line("continued first")
        assert.are.same({ first, first + 2 }, closed(first))
        assert.are.same({ -1, -1 }, closed(line("new 4")))
    end)

    it("folds short completed tool output using the native configuration", function()
        writer:write_tool_call_block({ tool_call_id = "short", kind = "execute", argument = "echo hello", status = "in_progress", body = { "short output" } })
        assert.are.same({ -1, -1 }, closed(line("short output")))
        writer:update_tool_call_block({ tool_call_id = "short", status = "completed" })
        assert.is_true(closed(line("short output"))[1] > 0)
        assert.are.same({ -1, -1 }, closed(line("execute(echo hello)")))
    end)

    it("keeps failed execution output and diffs expanded", function()
        writer:write_tool_call_block({ tool_call_id = "failed", kind = "execute", argument = "failing command", status = "failed", body = { "failed output" } })
        writer:write_tool_call_block({ tool_call_id = "diff", kind = "edit", argument = "file.lua", file_path = "file.lua", status = "completed", diff = { old = { "old value" }, new = { "new value" } } })
        assert.are.same({ -1, -1 }, closed(line("failed output")))
        assert.are.same({ -1, -1 }, closed(line("new value")))
    end)

    it("respects disabled folding", function()
        require("agentic.config").folding.tool_calls.enabled = false
        thought("disabled first\ndisabled second")
        answer()
        assert.are.same({ -1, -1 }, closed(line("disabled first")))
    end)

    it("discards queued ranges when a session is cleared", function()
        local apply = writer._apply_scroll
        writer._apply_scroll = function() end
        thought("discarded first\ndiscarded second")
        answer()
        f.manager:_cancel_session()
        writer._apply_scroll = nil
        writer:write_message(chunk("replacement first\nreplacement second", "agent_message_chunk"))
        apply(writer, writer.bufnr)
        assert.are.same({ -1, -1 }, closed(line("replacement first")))
    end)

    it("installs only once and preserves an already opened fold", function()
        local folds = require("sodium.agentic_folds")
        folds.install()
        folds.install()
        thought("idempotent first\nidempotent second")
        answer()
        local first = line("idempotent first")
        assert.are.same({ first, first + 1 }, closed(first))
        vim.api.nvim_win_call(f.manager.widget.win_nrs.chat, function() vim.cmd(first .. "foldopen") end)
        folds.install()
        answer("more answer")
        assert.are.same({ -1, -1 }, closed(first))
    end)

    it("does not operate on a destroyed chat buffer", function()
        local folds = require("sodium.agentic_folds")
        local buf = vim.api.nvim_create_buf(false, true)
        local stale = require("agentic.ui.message_writer"):new(buf)
        vim.api.nvim_buf_delete(buf, { force = true })
        assert.has_no_errors(function() folds.finish_thinking(stale) end)
    end)
end)