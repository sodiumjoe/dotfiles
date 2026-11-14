package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
dofile(vim.env.DOTFILES_TEST_ROOT .. "/home/.config/nvim/lua/sodium/plugins/agentic.lua").config()

describe("Chat tables", function()
    local f, writer, buf
    local ns = vim.api.nvim_create_namespace("sodium_chat_tables")
    before_each(function()
        f = require("fixtures.agency_native").new()
        writer = f.manager.message_writer
        buf = writer.bufnr
    end)
    after_each(function()
        f.close()
    end)
    local function say(text)
        writer:write_message_chunk({ sessionUpdate = "agent_message_chunk", content = { type = "text", text = text } })
    end
    local function settle()
        vim.treesitter.get_parser(buf, "markdown"):parse()
        f.flush()
    end
    local function marks()
        return vim.api.nvim_buf_get_extmarks(buf, ns, 0, -1, { details = true })
    end
    local function grids()
        local out = {}
        for _, mark in ipairs(marks()) do
            if mark[4].virt_lines then
                local lines = {}
                for _, line in ipairs(mark[4].virt_lines) do
                    local parts = {}
                    for _, chunk in ipairs(line) do parts[#parts + 1] = chunk[1] end
                    lines[#lines + 1] = table.concat(parts)
                end
                out[#out + 1] = { row = mark[2], lines = lines }
            end
        end
        return out
    end
    local function concealed()
        local rows = {}
        for _, mark in ipairs(marks()) do
            if mark[4].conceal_lines then rows[#rows + 1] = mark[2] end
        end
        table.sort(rows)
        return rows
    end
    local function row_of(text)
        for index, line in ipairs(vim.api.nvim_buf_get_lines(buf, 0, -1, false)) do
            if line == text then return index - 1 end
        end
        error("missing chat line: " .. text)
    end

    it("draws a table in an agent message as a grid hanging from the line above", function()
        say("Results:\n\n| Name | Value |\n|---|---|\n| alpha | 1 |\n\nDone.")
        settle()
        local header = row_of("| Name | Value |")
        assert.are.same({ header, header + 1, header + 2 }, concealed())
        local found = grids()
        assert.are.equal(1, #found)
        assert.are.equal(header - 1, found[1].row)
        assert.are.same({
            "┌───────┬───────┐",
            "│ Name  │ Value │",
            "├───────┼───────┤",
            "│ alpha │ 1     │",
            "└───────┴───────┘",
        }, found[1].lines)
    end)

    it("ends a table streamed one row at a time as one grid with every row", function()
        say("Stream:\n\n| N | Square |\n|---|---|\n")
        settle()
        for n = 1, 4 do
            say("| " .. n .. " | " .. n * n .. " |\n")
            settle()
        end
        say("| 5 | 2")
        settle()
        say("5 |\n\nend")
        settle()
        local found = grids()
        assert.are.equal(1, #found)
        local text = table.concat(found[1].lines, "\n")
        for n = 1, 5 do assert.is_truthy(text:find("│ " .. n .. " ", 1, true)) end
        assert.is_truthy(text:find("│ 25 ", 1, true))
        assert.are.equal(7, #concealed())
    end)

    it("updates a cell whose text grows without changing the table structure", function()
        say("Grow:\n\n| N | Value |\n|---|---|\n| 5 | 2")
        settle()
        say("5")
        settle()
        say(" and more words")
        settle()
        local text = table.concat(grids()[1].lines, "\n")
        assert.is_truthy(text:find("25 and more words", 1, true))
    end)

    it("leaves a table inside a tool block as raw text", function()
        writer:write_tool_call_block({ tool_call_id = "table", kind = "execute", argument = "cat table.md", status = "completed",
            body = { "| a | b |", "|---|---|", "| 1 | 2 |" } })
        settle()
        assert.are.same({}, marks())
    end)

    it("leaves one grid per table after the chat is cleared and the history replayed", function()
        local message = "Before:\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n"
        say(message)
        settle()
        f.manager.widget:clear()
        say(message)
        settle()
        assert.are.equal(1, #grids())
        assert.are.equal(3, #concealed())
    end)

    it("shows empty cells for short rows and drops cells beyond the header", function()
        say("Ragged:\n\n| A | B | C |\n|---|---|---|\n| 1 |  | 3 |\n| x |\n| p | q | r | extra |\n\n")
        settle()
        assert.are.same({
            "┌───┬───┬───┐",
            "│ A │ B │ C │",
            "├───┼───┼───┤",
            "│ 1 │   │ 3 │",
            "│ x │   │   │",
            "│ p │ q │ r │",
            "└───┴───┴───┘",
        }, grids()[1].lines)
    end)

    it("keeps escaped pipes inside their cell", function()
        say("Pipes:\n\n| Expr | Meaning |\n|---|---|\n| `a \\| b` | a or b |\n| x \\| y | pipe |\n\n")
        settle()
        local lines = grids()[1].lines
        assert.is_true(vim.tbl_contains(lines, "│ a | b │ a or b  │"))
        assert.is_true(vim.tbl_contains(lines, "│ x | y │ pipe    │"))
    end)

    it("draws two tables in one message from their own lines above", function()
        say("First:\n\n| A |\n|---|\n| 1 |\n\nSecond:\n\n| B |\n|---|\n| 2 |\n\n")
        settle()
        local found = grids()
        assert.are.equal(2, #found)
        assert.are.same({ row_of("| A |") - 1, row_of("| B |") - 1 }, { found[1].row, found[2].row })
    end)

    it("draws a table inside a thinking block only when the line above is part of the same block", function()
        writer:write_message_chunk({ sessionUpdate = "agent_thought_chunk", content = { type = "text",
            text = "| T |\n|---|\n| 1 |\n\nmore thought\n\n| U |\n|---|\n| 2 |\n" } })
        settle()
        local found = grids()
        assert.are.equal(1, #found)
        assert.are.equal(row_of("| U |") - 1, found[1].row)
    end)
    it("re-lays out the grid with wrapped cells when the window narrows", function()
        say("Notes:\n\n| Key | Notes |\n|---|---|\n| wrap | breaks long rows across screen lines in narrow windows |\n\n")
        settle()
        local win = f.manager.widget.win_nrs.chat
        local textoff = vim.fn.getwininfo(win)[1].textoff
        vim.api.nvim_win_set_width(win, textoff + 30)
        require("sodium.chat_tables").relayout(buf)
        local found = grids()
        assert.are.equal(1, #found)
        assert.is_true(#found[1].lines > 5)
        for _, line in ipairs(found[1].lines) do assert.are.equal(30, vim.fn.strdisplaywidth(line)) end
    end)

    it("leaves a table raw while the window is too narrow and draws it once the window is wide enough", function()
        local win = f.manager.widget.win_nrs.chat
        local textoff = vim.fn.getwininfo(win)[1].textoff
        vim.api.nvim_win_set_width(win, textoff + 40)
        say("Wide:\n\n| one | two | three | four | five |\n|---|---|---|---|---|\n| aaaaaaaaaa | bbbbbbbbbb | cccccccccc | dddddddddd | eeeeeeeeee |\n\n")
        settle()
        assert.are.same({}, concealed())
        assert.are.equal(0, #grids())
        vim.api.nvim_win_set_width(win, textoff + 60)
        require("sodium.chat_tables").relayout(buf)
        assert.are.equal(1, #grids())
        assert.are.equal(3, #concealed())
    end)

    it("keeps the drawn grids when a resize leaves the width unchanged", function()
        say("Same:\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n")
        settle()
        local function ids()
            return vim.tbl_map(function(mark) return mark[1] end, marks())
        end
        local before = ids()
        require("sodium.chat_tables").relayout(buf)
        assert.are.same(before, ids())
    end)

    it("draws a table inside a block quote from the quoted text", function()
        say("Quote:\n\n> | A | B |\n> |---|---|\n> | 1 | 2 |\n\n")
        settle()
        assert.are.same({
            "┌───┬───┐",
            "│ A │ B │",
            "├───┼───┤",
            "│ 1 │ 2 │",
            "└───┴───┘",
        }, grids()[1].lines)
    end)
end)