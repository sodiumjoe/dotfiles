package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
dofile(vim.env.DOTFILES_TEST_ROOT .. "/home/.config/nvim/lua/sodium/plugins/agentic.lua").config()
local markdown_specs = dofile(vim.env.DOTFILES_TEST_ROOT .. "/home/.config/nvim/lua/sodium/plugins/markdown.lua")
require("render-markdown").setup(markdown_specs[1].opts)

describe("Chat tables", function()
    local f, writer, buf, win, columns
    local ns = vim.api.nvim_create_namespace("render-markdown.nvim")
    local long_row = "| wrap | breaks long rows across screen lines in narrow windows and keeps going |"
    before_each(function()
        f = require("fixtures.agency_native").new()
        writer = f.manager.message_writer
        buf = writer.bufnr
        win = f.manager.widget.win_nrs.chat
        columns = vim.o.columns
        vim.o.columns = vim.fn.getwininfo(win)[1].textoff + 40
    end)
    after_each(function()
        f.close()
        vim.o.columns = columns
    end)
    local function say(text)
        writer:write_message_chunk({ sessionUpdate = "agent_message_chunk", content = { type = "text", text = text } })
    end
    local function render()
        vim.treesitter.get_parser(buf, "markdown"):parse()
        f.flush()
        require("render-markdown.api").render({ buf = buf, win = win })
        f.flush()
    end
    local function row_of(text)
        for index, line in ipairs(vim.api.nvim_buf_get_lines(buf, 0, -1, false)) do
            if line == text then
                return index - 1
            end
        end
        error("missing chat line: " .. text)
    end
    local function marks(first, last)
        return vim.api.nvim_buf_get_extmarks(buf, ns, { first, 0 }, { last, -1 }, { details = true })
    end
    local function wrapped_lines(first, last)
        local out = {}
        for _, mark in ipairs(marks(first, last)) do
            for _, line in ipairs(mark[4].virt_lines or {}) do
                local parts = {}
                for _, chunk in ipairs(line) do
                    parts[#parts + 1] = chunk[1]
                end
                out[#out + 1] = { row = mark[2], text = table.concat(parts) }
            end
        end
        return out
    end

    it("wraps a wide row inside its columns in a narrow chat window", function()
        say("Notes:\n\n| Key | Notes |\n|---|---|\n" .. long_row .. "\n| short | ok |\n\n")
        render()
        local row = row_of(long_row)
        local concealed = vim.tbl_filter(function(mark)
            return mark[4].conceal_lines
        end, marks(row, row))
        assert.are.equal(1, #concealed)
        local text = {}
        for _, line in ipairs(wrapped_lines(row - 1, row)) do
            text[#text + 1] = line.text
        end
        assert.is_true(#text > 1)
        for _, line in ipairs(text) do
            assert.are.equal(vim.fn.strchars(text[1]), vim.fn.strchars(line))
        end
        assert.is_truthy(table.concat(text, "\n"):find("keeps going", 1, true))
    end)

    it("keeps one copy of a wrapped row after the cursor passes over it", function()
        say("Notes:\n\n| Key | Notes |\n|---|---|\n| short | ok |\n" .. long_row .. "\n\nAfter the table.\n")
        render()
        local row = row_of(long_row)
        local before = #wrapped_lines(0, -1)
        vim.api.nvim_set_current_win(win)
        for _ = 1, 3 do
            vim.api.nvim_win_set_cursor(win, { row + 1, 0 })
            require("render-markdown.api").render({ buf = buf, win = win, force = false, event = "CursorMoved" })
            f.flush()
            vim.api.nvim_win_set_cursor(win, { row_of("After the table.") + 1, 0 })
            require("render-markdown.api").render({ buf = buf, win = win, force = false, event = "CursorMoved" })
            f.flush()
        end
        assert.are.equal(before, #wrapped_lines(0, -1))
    end)

    it("leaves a table inside a tool block as raw text", function()
        writer:write_tool_call_block({
            tool_call_id = "table",
            kind = "execute",
            argument = "cat table.md",
            status = "completed",
            body = { "| a | b |", "|---|---|", "| 1 | 2 |" },
        })
        render()
        local header = row_of("| a | b |")
        assert.are.same({}, marks(header, header + 2))
    end)

    it("folds a thinking block's wrapped last table row with the block", function()
        writer:write_message_chunk({
            sessionUpdate = "agent_thought_chunk",
            content = {
                type = "text",
                text = "Thinking first.\n\n| Key | Notes |\n|---|---|\n" .. long_row .. "\n",
            },
        })
        say("The answer.")
        render()
        local first, row = row_of("🧠 Thinking first."), row_of(long_row)
        require("agentic.ui.tool_call_fold").close_range(buf, first + 1, row + 1)
        local lines = wrapped_lines(first, row + 2)
        assert.is_true(#lines > 1)
        vim.api.nvim_win_call(win, function()
            for _, line in ipairs(lines) do
                assert.are_not.equal(-1, vim.fn.foldclosed(line.row + 1))
            end
        end)
    end)

    it("highlights the chat without the whole-line conceal rules that force a full parse on every edit", function()
        dofile(vim.env.DOTFILES_TEST_ROOT .. "/home/.config/nvim/lua/sodium/plugins/treesitter.lua")[1].config()
        vim.treesitter.stop(buf)
        vim.bo[buf].filetype = "AgenticChat"
        local chat = vim.treesitter.highlighter.active[buf]
        assert.is_not_nil(chat)
        assert.is_not_true(chat:get_query("markdown"):query().has_conceal_line)
        local file = vim.api.nvim_create_buf(true, false)
        vim.bo[file].filetype = "markdown"
        assert.is_true(vim.treesitter.highlighter.active[file]:get_query("markdown"):query().has_conceal_line)
        vim.api.nvim_buf_delete(file, { force = true })
    end)
end)