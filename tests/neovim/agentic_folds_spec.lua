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

    it("labels a folded thinking block differently from folded tool output", function()
        thought("label first\nlabel second")
        answer()
        writer:write_tool_call_block({ tool_call_id = "labelled", kind = "execute", argument = "echo", status = "completed", body = { "tool output" } })
        local function text(lnum)
            return vim.api.nvim_win_call(f.manager.widget.win_nrs.chat, function() return vim.fn.foldtextresult(lnum) end)
        end
        assert.are.equal("  Thinking · 2 lines", text(line("label first")))
        assert.is_nil(text(line("tool output")):find("Thinking", 1, true))
    end)

    it("folds completed output at threshold zero without measuring decorated height", function()
        local height = vim.api.nvim_win_text_height
        vim.api.nvim_win_text_height = function() error("decorated height should not be measured") end
        local ok, failure = xpcall(function()
            writer:write_tool_call_block({ tool_call_id = "fast", kind = "execute", argument = "output", status = "completed", body = { "completed output" } })
            writer:write_tool_call_block({ tool_call_id = "fast-diff", kind = "edit", argument = "fast.lua", file_path = "fast.lua", status = "completed", diff = { old = { "old fast" }, new = { "new fast" } } })
            assert.is_true(closed(line("completed output"))[1] > 0)
            assert.is_true(closed(line("new fast"))[1] > 0)
        end, debug.traceback)
        vim.api.nvim_win_text_height = height
        assert.is_true(ok, failure)
    end)

    it("rejects invalid or hidden ranges at threshold zero", function()
        local Fold = require("agentic.ui.tool_call_fold")
        local buf = writer.bufnr
        assert.is_false(Fold.should_fold({ bufnr = buf, start_row = 2, end_row = 1, status = "completed" }))
        assert.is_false(Fold.should_fold({ bufnr = buf, start_row = -1, end_row = 0, status = "completed" }))
        local count = vim.api.nvim_buf_line_count(buf)
        assert.is_false(Fold.should_fold({ bufnr = buf, start_row = 0, end_row = count, status = "completed" }))
        assert.is_false(Fold.should_fold({ bufnr = buf, start_row = 0, end_row = 0, status = "in_progress" }))
        assert.is_false(Fold.should_fold({ bufnr = buf, start_row = 0, end_row = 0, status = "failed", is_diff = true }))
        local hidden = vim.api.nvim_create_buf(false, true)
        assert.is_false(Fold.should_fold({ bufnr = hidden, start_row = 0, end_row = 0, status = "completed" }))
        vim.api.nvim_buf_delete(hidden, { force = true })
        assert.is_false(Fold.should_fold({ bufnr = hidden, start_row = 0, end_row = 0, status = "completed" }))
    end)

    it("uses rendered height for positive thresholds and configured failed output", function()
        local config = require("agentic.config").folding.tool_calls
        config.threshold = 3
        writer:write_tool_call_block({ tool_call_id = "wrapped", kind = "execute", argument = "long", status = "completed", body = { string.rep("word ", 300) } })
        assert.is_true(closed(line("word word"))[1] > 0)
        config.threshold, config.fold_on_error = 0, true
        writer:write_tool_call_block({ tool_call_id = "configured-error", kind = "execute", argument = "error", status = "failed", body = { "configured failed output" } })
        assert.is_true(closed(line("configured failed output"))[1] > 0)
    end)

    it("folds completed edit diffs while leaving their headers and status visible", function()
        writer:write_tool_call_block({ tool_call_id = "diff", kind = "edit", argument = "file.lua", file_path = "file.lua", status = "completed", diff = { old = { "old value" }, new = { "new value" } } })
        assert.is_true(closed(line("new value"))[1] > 0)
        assert.are.same({ -1, -1 }, closed(line("edit(file.lua)")))
        assert.are.same({ -1, -1 }, closed(line("completed")))
    end)

    it("keeps in-progress edit diffs expanded until completion", function()
        writer:write_tool_call_block({ tool_call_id = "diff", kind = "edit", argument = "file.lua", file_path = "file.lua", status = "in_progress", diff = { old = { "old value" }, new = { "new value" } } })
        assert.are.same({ -1, -1 }, closed(line("new value")))
        writer:update_tool_call_block({ tool_call_id = "diff", status = "completed" })
        assert.is_true(closed(line("new value"))[1] > 0)
    end)

    it("folds failed execution output under its header and keeps failed edit diffs expanded", function()
        writer:write_tool_call_block({ tool_call_id = "failed", kind = "execute", argument = "failing command", status = "in_progress", body = { "failed output" } })
        writer:update_tool_call_block({ tool_call_id = "failed", status = "failed" })
        writer:write_tool_call_block({ tool_call_id = "diff", kind = "edit", argument = "file.lua", file_path = "file.lua", status = "in_progress", diff = { old = { "old value" }, new = { "new value" } } })
        writer:update_tool_call_block({ tool_call_id = "diff", status = "failed" })
        assert.is_true(closed(line("failed output"))[1] > 0)
        assert.are.same({ -1, -1 }, closed(line("execute(failing command)")))
        assert.are.same({ -1, -1 }, closed(line("new value")))
    end)

    it("respects disabled folding and the configured threshold for completed diffs", function()
        local config = require("agentic.config").folding.tool_calls
        config.enabled = false
        writer:write_tool_call_block({ tool_call_id = "disabled", kind = "edit", argument = "disabled.lua", file_path = "disabled.lua", status = "completed", diff = { old = { "old disabled" }, new = { "new disabled" } } })
        assert.are.same({ -1, -1 }, closed(line("new disabled")))
        config.enabled = true
        config.threshold = 1000
        writer:write_tool_call_block({ tool_call_id = "threshold", kind = "edit", argument = "threshold.lua", file_path = "threshold.lua", status = "completed", diff = { old = { "old threshold" }, new = { "new threshold" } } })
        assert.are.same({ -1, -1 }, closed(line("new threshold")))
    end)

    it("installs diff folding only once and preserves manually reopened diffs on update", function()
        local folds = require("sodium.agentic_folds")
        local should_fold = require("agentic.ui.tool_call_fold").should_fold
        folds.install()
        folds.install()
        assert.are.equal(should_fold, require("agentic.ui.tool_call_fold").should_fold)
        writer:write_tool_call_block({ tool_call_id = "diff", kind = "edit", argument = "file.lua", file_path = "file.lua", status = "completed", diff = { old = { "old value" }, new = { "new value" } } })
        local first = line("new value")
        assert.is_true(closed(first)[1] > 0)
        vim.api.nvim_win_call(f.manager.widget.win_nrs.chat, function() vim.cmd(first .. "foldopen") end)
        folds.install()
        writer:update_tool_call_block({ tool_call_id = "diff", status = "completed" })
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

    it("drops the borders of cleared tool blocks when the chat is cleared for another session", function()
        local Blocks = require("agentic.ui.tool_call_blocks")
        writer:write_tool_call_block({ tool_call_id = "before", kind = "execute", argument = "ls", status = "completed", body = { "old output" } })
        f.manager.widget:clear()
        answer("after the clear")
        assert.is_nil(Blocks.block_range_at_row(writer.bufnr, line("after the clear") - 1))
    end)

    it("highlights the chat without the whole-line conceal rules that force a full parse on every edit", function()
        dofile(vim.env.DOTFILES_TEST_ROOT .. "/home/.config/nvim/lua/sodium/plugins/treesitter.lua")[1].config()
        vim.treesitter.stop(writer.bufnr)
        vim.bo[writer.bufnr].filetype = "AgenticChat"
        local chat = vim.treesitter.highlighter.active[writer.bufnr]
        assert.is_not_nil(chat)
        assert.is_not_true(chat:get_query("markdown"):query().has_conceal_line)
        local file = vim.api.nvim_create_buf(true, false)
        vim.bo[file].filetype = "markdown"
        assert.is_true(vim.treesitter.highlighter.active[file]:get_query("markdown"):query().has_conceal_line)
        vim.api.nvim_buf_delete(file, { force = true })
    end)
end)