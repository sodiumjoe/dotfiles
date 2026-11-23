describe("Annotations", function()
    local annotations, bufs
    local ns = vim.api.nvim_create_namespace("sodium_annotations")
    local render_ns = vim.api.nvim_create_namespace("sodium_annotations_render")
    before_each(function()
        annotations = require("sodium.annotations")
        bufs = {}
    end)
    after_each(function()
        vim.cmd("stopinsert")
        for _, win in ipairs(vim.api.nvim_list_wins()) do
            if vim.api.nvim_win_get_config(win).relative ~= "" then
                vim.api.nvim_win_close(win, true)
            end
        end
        vim.cmd("silent! only")
        annotations.clear()
        for _, buf in ipairs(bufs) do
            if vim.api.nvim_buf_is_valid(buf) then
                vim.api.nvim_buf_delete(buf, { force = true })
            end
        end
    end)
    local function scratch(lines, listed)
        local buf = vim.api.nvim_create_buf(listed or false, not listed)
        vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
        bufs[#bufs + 1] = buf
        return buf
    end
    local function shown(lines)
        local buf = scratch(lines)
        vim.api.nvim_win_set_buf(0, buf)
        vim.wo.cursorline = false
        return buf
    end
    local function virt(buf)
        return vim.api.nvim_buf_get_extmarks(buf, render_ns, 0, -1, { details = true })
    end
    local function rows(lines)
        return vim.tbl_map(function(chunks)
            return table.concat(vim.tbl_map(function(chunk)
                return chunk[1]
            end, chunks))
        end, lines)
    end
    local function float()
        local win = vim.api.nvim_get_current_win()
        assert.are_not.equal("", vim.api.nvim_win_get_config(win).relative)
        return win, vim.api.nvim_win_get_buf(win)
    end
    local function press(lhs, mode)
        vim.fn.maparg(lhs, mode, false, true).callback()
    end

    it("shows the note as a bordered box under the last row with the gutter icon on its first line", function()
        local buf = shown({ "zero", "one", "two", "three" })
        annotations.set(buf, 1, 2, "first note\nsecond")
        local marks = virt(buf)
        assert.are.equal(1, #marks)
        assert.are.equal(2, marks[1][2])
        assert.same({
            "╭────────────╮",
            "│ first note │",
            "│ second     │",
            "╰────────────╯",
        }, rows(marks[1][4].virt_lines))
        assert.same({ "first note", "AgencyAnnotation" }, marks[1][4].virt_lines[2][3])
        local win = vim.api.nvim_get_current_win()
        assert.is_nil(annotations.gutter(win, 3, -4))
        assert.truthy(annotations.gutter(win, 3, -3))
        assert.is_nil(annotations.gutter(win, 3, -2))
        assert.is_nil(annotations.gutter(win, 2, -1))
    end)

    it("moves the range and its note with inserted lines and keeps it after deletion", function()
        local buf = scratch({ "aa", "bb", "cc", "dd", "ee" })
        local mark = annotations.set(buf, 1, 2, "note")
        vim.api.nvim_buf_set_lines(buf, 1, 1, false, { "new" })
        assert.same({ { buf = buf, mark = mark, first = 2, last = 3, note = "note" } }, annotations.list())
        vim.api.nvim_buf_set_text(buf, 3, 1, 3, 1, { "", "" })
        vim.api.nvim_exec_autocmds("TextChanged", { buffer = buf })
        assert.are.equal(4, annotations.list()[1].last)
        assert.are.equal(4, virt(buf)[1][2])
        vim.api.nvim_buf_set_lines(buf, 2, 5, false, {})
        assert.are.equal(1, #annotations.list())
        local item = annotations.list()[1]
        assert.is_nil(annotations.set(buf, item.first, item.last, "", mark))
        assert.same({}, vim.api.nvim_buf_get_extmarks(buf, ns, 0, -1, {}))
        assert.same({}, virt(buf))
        assert.same({}, annotations.list())
    end)

    it("keeps the range when lines are opened below its last row", function()
        local buf = shown({ "aa", "bb", "cc", "dd" })
        annotations.set(buf, 1, 2, "note")
        local captured = annotations.annotations()
        vim.api.nvim_win_set_cursor(0, { 3, 0 })
        vim.cmd("normal! oadded")
        assert.are.equal("added", vim.api.nvim_buf_get_lines(buf, 3, 4, false)[1])
        assert.are.equal(1, annotations.list()[1].first)
        assert.are.equal(2, annotations.list()[1].last)
        vim.api.nvim_win_set_cursor(0, { 3, 0 })
        vim.cmd("normal! A\rsplit")
        assert.are.equal("split", vim.api.nvim_buf_get_lines(buf, 3, 4, false)[1])
        assert.are.equal(2, annotations.list()[1].last)
        annotations.accept_annotations(captured)
        assert.same({}, annotations.list())
    end)

    it("formats annotations across buffers and accepts only the unchanged ones", function()
        local named = scratch({ "one", "two", "three" })
        vim.api.nvim_buf_set_name(named, vim.fn.getcwd() .. "/annotated.txt")
        local unnamed = scratch({ "x", "y" })
        local first = annotations.set(named, 0, 1, "first")
        local second = annotations.set(unnamed, 1, 1, "second")
        local captured = annotations.annotations()
        assert.same({
            {
                buf = named,
                mark = first,
                first = 0,
                last = 1,
                note = "first",
                text = "File: annotated.txt\nLines: 1-2\n> one\n> two\nNote: first",
            },
            {
                buf = unnamed,
                mark = second,
                first = 1,
                last = 1,
                note = "second",
                text = "File: [buffer " .. unnamed .. "]\nLines: 2-2\n> y\nNote: second",
            },
        }, captured)
        annotations.set(unnamed, 1, 1, "edited", second)
        annotations.accept_annotations(captured)
        assert.same({ { buf = unnamed, mark = second, first = 1, last = 1, note = "edited" } }, annotations.list())
    end)

    it("drops a buffer's annotations when it is unloaded", function()
        local buf = scratch({ "a", "b" }, true)
        annotations.set(buf, 0, 1, "note")
        assert.are.equal(1, #annotations.list())
        vim.bo[buf].modified = false
        vim.cmd("bdelete " .. buf)
        assert.same({}, annotations.list())
    end)

    it("saves a note typed in the float on the cursor line and returns to the source window", function()
        local buf = shown({ "one", "two", "three", "four", "five" })
        local source = vim.api.nvim_get_current_win()
        vim.api.nvim_win_set_cursor(source, { 3, 1 })
        annotations.edit_at_cursor()
        local win, fbuf = float()
        assert.are.equal("markdown", vim.bo[fbuf].filetype)
        assert.are.equal("wipe", vim.bo[fbuf].bufhidden)
        vim.api.nvim_buf_set_lines(fbuf, 0, -1, false, { "fix this", "" })
        press("<C-s>", "i")
        assert.is_true(vim.wait(1000, function()
            return not vim.api.nvim_win_is_valid(win)
        end))
        assert.are.equal(source, vim.api.nvim_get_current_win())
        assert.same({ 3, 1 }, vim.api.nvim_win_get_cursor(source))
        assert.same(
            { { buf = buf, mark = annotations.at(buf, 2), first = 2, last = 2, note = "fix this" } },
            annotations.list()
        )
        assert.same({ "╭──────────╮", "│ fix this │", "╰──────────╯" }, rows(virt(buf)[1][4].virt_lines))
    end)

    it("annotates the visual line range", function()
        local buf = shown({ "one", "two", "three", "four", "five" })
        vim.cmd("normal! 2GVjj")
        assert.are.equal("V", vim.fn.mode())
        annotations.edit_at_cursor()
        local _, fbuf = float()
        vim.api.nvim_buf_set_lines(fbuf, 0, -1, false, { "range" })
        press("<C-s>", "n")
        assert.are.equal(1, annotations.list()[1].first)
        assert.are.equal(3, annotations.list()[1].last)
        assert.are.equal(buf, annotations.list()[1].buf)
    end)

    it("edits an existing note, deletes it when emptied, and leaves it on cancel", function()
        local buf = shown({ "one", "two", "three", "four" })
        local mark = annotations.set(buf, 1, 2, "old\nnote")
        vim.api.nvim_win_set_cursor(0, { 2, 0 })
        annotations.edit_at_cursor()
        local win, fbuf = float()
        assert.same({ "old", "note" }, vim.api.nvim_buf_get_lines(fbuf, 0, -1, false))
        assert.same({ 2, 3 }, vim.api.nvim_win_get_cursor(win))
        vim.api.nvim_buf_set_lines(fbuf, 0, -1, false, { "new note" })
        press("<CR>", "n")
        assert.same({ { buf = buf, mark = mark, first = 1, last = 2, note = "new note" } }, annotations.list())
        annotations.edit_at_cursor()
        _, fbuf = float()
        vim.api.nvim_buf_set_lines(fbuf, 0, -1, false, { "discarded" })
        press("q", "n")
        assert.same({ { buf = buf, mark = mark, first = 1, last = 2, note = "new note" } }, annotations.list())
        annotations.edit_at_cursor()
        _, fbuf = float()
        vim.api.nvim_buf_set_lines(fbuf, 0, -1, false, { "", "  " })
        press("<C-s>", "n")
        assert.same({}, annotations.list())
        assert.same({}, virt(buf))
    end)

    it("keeps the typed text at the original range when the annotation vanished while the float was open", function()
        local buf = shown({ "one", "two", "three", "four" })
        local mark = annotations.set(buf, 1, 2, "old")
        vim.api.nvim_win_set_cursor(0, { 2, 0 })
        annotations.edit_at_cursor()
        local _, fbuf = float()
        annotations.delete(buf, mark)
        vim.api.nvim_buf_set_lines(fbuf, 0, -1, false, { "refined" })
        press("<C-s>", "n")
        local list = annotations.list()
        assert.are.equal(1, #list)
        assert.are.equal("refined", list[1].note)
        assert.are.equal(1, list[1].first)
        assert.are.equal(2, list[1].last)
    end)

    it("keeps the typed text when the buffer's annotations were cleared while the float was open", function()
        local buf = shown({ "one", "two", "three", "four" })
        annotations.set(buf, 1, 2, "old")
        vim.api.nvim_win_set_cursor(0, { 2, 0 })
        annotations.edit_at_cursor()
        local _, fbuf = float()
        annotations.clear(buf)
        vim.api.nvim_buf_set_lines(fbuf, 0, -1, false, { "refined" })
        press("<C-s>", "n")
        local list = annotations.list()
        assert.are.equal(1, #list)
        assert.are.equal("refined", list[1].note)
        assert.are.equal(1, list[1].first)
        assert.are.equal(2, list[1].last)
    end)

    it("discards the note when focus leaves the float for another window", function()
        local buf = shown({ "one", "two" })
        vim.cmd("split")
        local other = vim.api.nvim_get_current_win()
        vim.cmd("wincmd p")
        annotations.edit_at_cursor()
        local win, fbuf = float()
        vim.api.nvim_buf_set_lines(fbuf, 0, -1, false, { "lost" })
        vim.api.nvim_set_current_win(other)
        assert.is_true(vim.wait(1000, function()
            return not vim.api.nvim_win_is_valid(win)
        end))
        assert.are.equal(other, vim.api.nvim_get_current_win())
        assert.same({}, annotations.list(buf))
    end)

    it("jumps to the next and previous annotation with wrapping and deletes the one at the cursor", function()
        local buf = shown({ "a", "b", "c", "d", "e" })
        annotations.set(buf, 1, 1, "one")
        annotations.set(buf, 3, 4, "two")
        vim.api.nvim_win_set_cursor(0, { 1, 0 })
        local function row()
            return vim.api.nvim_win_get_cursor(0)[1]
        end
        annotations.next()
        assert.are.equal(2, row())
        annotations.next()
        assert.are.equal(4, row())
        annotations.next()
        assert.are.equal(2, row())
        annotations.prev()
        assert.are.equal(4, row())
        annotations.prev()
        assert.are.equal(2, row())
        annotations.delete_at_cursor()
        assert.same(
            { "two" },
            vim.tbl_map(function(item)
                return item.note
            end, annotations.list(buf))
        )
    end)

    it("lists the annotations of every buffer in a picker in order", function()
        local first = shown({ "a", "b", "c" })
        local second = scratch({ "x", "y" })
        vim.api.nvim_buf_set_name(first, "/tmp/annotations_first.txt")
        vim.api.nvim_buf_set_name(second, "/tmp/annotations_second.txt")
        annotations.set(second, 0, 1, "later\nignored")
        annotations.set(first, 2, 2, "tail")
        annotations.set(first, 0, 1, "head")
        local snacks = require("snacks")
        local picker, opened = snacks.picker, nil
        snacks.picker = function(opts)
            opened = opts
        end
        annotations.pick()
        snacks.picker = picker
        local function field(name)
            return vim.tbl_map(function(item)
                return item[name]
            end, opened.items)
        end
        assert.are.equal("Annotations", opened.title)
        assert.same({ "head", "tail", "later" }, field("line"))
        assert.same({ first, first, second }, field("buf"))
        local first_name, second_name = vim.api.nvim_buf_get_name(first), vim.api.nvim_buf_get_name(second)
        assert.same({ first_name, first_name, second_name }, field("file"))
        assert.same({ { 1, 0 }, { 3, 0 }, { 1, 0 } }, field("pos"))
        assert.same({ { 2, 0 }, { 3, 0 }, { 2, 0 } }, field("end_pos"))
    end)
end)