local M = {}

local ns = vim.api.nvim_create_namespace("sodium_annotations")
local render_ns = vim.api.nvim_create_namespace("sodium_annotations_render")
local notes, icons, seq = {}, {}, 0
local icon = ""

local function highlights()
    local yellow = require("sodium.config.colorscheme").palette.yellow
    vim.api.nvim_set_hl(0, "AgencyAnnotation", { default = true, fg = yellow, italic = true })
    vim.api.nvim_set_hl(0, "AgencyAnnotationBorder", { default = true, fg = yellow })
    vim.api.nvim_set_hl(0, "AgencyAnnotationSign", { default = true, fg = yellow })
    vim.api.nvim_set_hl(0, "AgencyAnnotationStale", { default = true, link = "DiagnosticWarn" })
end
highlights()
vim.api.nvim_create_autocmd(
    "ColorScheme",
    { group = vim.api.nvim_create_augroup("sodium_annotations", { clear = true }), callback = highlights }
)

local function group(buf)
    return "sodium_annotations_" .. buf
end

local function drop(buf)
    notes[buf], icons[buf] = nil, nil
    pcall(vim.api.nvim_del_augroup_by_name, group(buf))
end

local function range(buf, mark)
    local pos = vim.api.nvim_buf_get_extmark_by_id(buf, ns, mark, { details = true })
    if #pos == 0 then
        if notes[buf] then
            notes[buf][mark] = nil
        end
        return
    end
    return pos[1], math.max(pos[1], pos[3].end_row)
end

local function valid(buf)
    if notes[buf] and not vim.api.nvim_buf_is_valid(buf) then
        drop(buf)
    end
    return notes[buf] ~= nil
end

local STALE = "annotated text changed on disk"

local function box(buf, first, text, stale)
    local indent = (" "):rep(vim.api.nvim_buf_call(buf, function()
        return vim.fn.indent(first + 1)
    end))
    local body, width = vim.split(text, "\n"), 0
    if stale then
        table.insert(body, 1, STALE)
    end
    for _, line in ipairs(body) do
        width = math.max(width, vim.fn.strdisplaywidth(line))
    end
    local rule = ("─"):rep(width + 2)
    local border = stale and "AgencyAnnotationStale" or "AgencyAnnotationBorder"
    local lines = { { { indent }, { "╭" .. rule .. "╮", border } } }
    for index, line in ipairs(body) do
        lines[#lines + 1] = {
            { indent },
            { "│ ", border },
            {
                line .. (" "):rep(width - vim.fn.strdisplaywidth(line)),
                stale and index == 1 and "AgencyAnnotationStale" or "AgencyAnnotation",
            },
            { " │", border },
        }
    end
    lines[#lines + 1] = { { indent }, { "╰" .. rule .. "╯", border } }
    return lines
end

local function render(buf)
    if not valid(buf) then
        return
    end
    vim.api.nvim_buf_clear_namespace(buf, render_ns, 0, -1)
    local rows = {}
    for mark, note in pairs(notes[buf]) do
        local first, last = range(buf, mark)
        if last then
            if not note.stale then
                note.lines = vim.api.nvim_buf_get_lines(buf, first, last + 1, false)
            end
            rows[last] = rows[last] or {}
            table.insert(rows[last], { first = first, seq = note.seq, text = note.text, stale = note.stale })
        end
    end
    icons[buf] = {}
    for last, stack in pairs(rows) do
        table.sort(stack, function(a, b)
            if a.first ~= b.first then
                return a.first < b.first
            end
            return a.seq < b.seq
        end)
        local lines, marks = {}, {}
        for _, item in ipairs(stack) do
            marks[#lines + 2] = true
            vim.list_extend(lines, box(buf, item.first, item.text, item.stale))
        end
        icons[buf][last] = marks
        vim.api.nvim_buf_set_extmark(buf, render_ns, last, 0, { virt_lines = lines })
    end
end

local function matches(lines, start, snapshot)
    for index, line in ipairs(snapshot) do
        if lines[start + index] ~= line then
            return false
        end
    end
    return true
end

local function reanchor(buf)
    if not valid(buf) then
        return
    end
    local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
    local moves = {}
    for mark, note in pairs(notes[buf]) do
        local first = range(buf, mark)
        if first and note.lines and not matches(lines, first, note.lines) then
            local best
            for start = 0, #lines - #note.lines do
                if matches(lines, start, note.lines) and (not best or math.abs(start - first) < math.abs(best - first)) then
                    best = start
                end
            end
            if best then
                moves[#moves + 1] = { mark = mark, first = best, last = best + #note.lines - 1, text = note.text }
            else
                note.stale = true
            end
        end
    end
    for _, move in ipairs(moves) do
        M.set(buf, move.first, move.last, move.text, move.mark)
    end
    render(buf)
end

local function attach(buf)
    if notes[buf] then
        return
    end
    notes[buf] = {}
    local id = vim.api.nvim_create_augroup(group(buf), { clear = true })
    vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI" }, {
        group = id,
        buffer = buf,
        callback = function()
            if next(notes[buf] or {}) then
                render(buf)
            end
        end,
    })
    vim.api.nvim_create_autocmd("FileChangedShellPost", {
        group = id,
        buffer = buf,
        callback = function()
            reanchor(buf)
        end,
    })
    vim.api.nvim_create_autocmd({ "BufUnload", "BufWipeout" }, {
        group = id,
        buffer = buf,
        callback = function()
            drop(buf)
        end,
    })
end

function M.delete(buf, mark)
    if not valid(buf) then
        return
    end
    vim.api.nvim_buf_del_extmark(buf, ns, mark)
    notes[buf][mark] = nil
    render(buf)
end

function M.set(buf, first, last, text, mark)
    if not text or not text:match("%S") then
        if mark then
            M.delete(buf, mark)
        end
        return
    end
    attach(buf)
    local line = vim.api.nvim_buf_get_lines(buf, last, last + 1, true)[1]
    mark = vim.api.nvim_buf_set_extmark(buf, ns, first, 0, {
        id = mark,
        end_row = last,
        end_col = #line,
        right_gravity = true,
        end_right_gravity = false,
    })
    seq = seq + 1
    local previous = notes[buf][mark]
    notes[buf][mark] = { text = text, seq = seq, lines = previous and previous.lines }
    render(buf)
    return mark
end

function M.at(buf, row)
    if not valid(buf) then
        return
    end
    local found
    for mark, note in pairs(notes[buf]) do
        local first, last = range(buf, mark)
        if first and first <= row and row <= last and (not found or note.seq > notes[buf][found].seq) then
            found = mark
        end
    end
    return found
end

function M.list(only)
    local items = {}
    for buf in pairs(notes) do
        if (not only or buf == only) and valid(buf) then
            for mark, note in pairs(notes[buf]) do
                local first, last = range(buf, mark)
                if first then
                    items[#items + 1] = { buf = buf, mark = mark, first = first, last = last, note = note.text }
                    if note.stale then
                        items[#items].stale = note.lines
                    end
                end
            end
        end
    end
    table.sort(items, function(a, b)
        if a.buf ~= b.buf then
            return a.buf < b.buf
        end
        if a.first ~= b.first then
            return a.first < b.first
        end
        return a.mark < b.mark
    end)
    return items
end

function M.annotations()
    local items = M.list()
    for _, item in ipairs(items) do
        local name = vim.api.nvim_buf_get_name(item.buf)
        local block = {
            "File: " .. (name == "" and "[buffer " .. item.buf .. "]" or vim.fn.fnamemodify(name, ":.")),
            ("Lines: %d-%d"):format(item.first + 1, item.last + 1),
        }
        for _, line in ipairs(item.stale or vim.api.nvim_buf_get_lines(item.buf, item.first, item.last + 1, false)) do
            block[#block + 1] = "> " .. line
        end
        if item.stale then
            block[#block + 1] = "Warning: the quoted lines were annotated before the file changed on disk; they are no longer at these lines."
        end
        block[#block + 1] = "Note: " .. item.note
        item.text = table.concat(block, "\n")
        item.stale = nil
    end
    return items
end

function M.summary(items)
    items = vim.tbl_filter(function(item)
        return type(item.buf) == "number" and vim.api.nvim_buf_is_valid(item.buf) and item.first and item.last and item.note
    end, items)
    if #items == 0 then
        return
    end
    local lines = { #items == 1 and "1 annotation" or #items .. " annotations" }
    for _, item in ipairs(items) do
        local name = vim.api.nvim_buf_get_name(item.buf)
        local path = name == "" and "[buffer " .. item.buf .. "]" or vim.fn.fnamemodify(name, ":.")
        local lines_label = item.first == item.last and tostring(item.first + 1) or ("%d-%d"):format(item.first + 1, item.last + 1)
        local note = vim.split(item.note, "\n")[1]
        lines[#lines + 1] = ("- %s:%s · %s"):format(path, lines_label, note)
    end
    return lines
end

function M.accept_annotations(captured)
    for _, item in ipairs(captured) do
        local note = valid(item.buf) and notes[item.buf][item.mark]
        if note and note.text == item.note then
            local first, last = range(item.buf, item.mark)
            if first == item.first and last == item.last then
                M.delete(item.buf, item.mark)
            end
        end
    end
end

function M.clear(buf)
    local bufs = buf and { buf } or vim.tbl_keys(notes)
    for _, b in ipairs(bufs) do
        if valid(b) then
            vim.api.nvim_buf_clear_namespace(b, ns, 0, -1)
            vim.api.nvim_buf_clear_namespace(b, render_ns, 0, -1)
        end
        drop(b)
    end
end

function M.edit(buf, first, last)
    local source_win, cursor = vim.api.nvim_get_current_win(), vim.api.nvim_win_get_cursor(0)
    local mark = M.at(buf, first)
    local text = ""
    if mark then
        text = notes[buf][mark].text
        first, last = range(buf, mark)
    end
    local lines = vim.split(text, "\n")
    local fbuf = vim.api.nvim_create_buf(false, true)
    vim.bo[fbuf].bufhidden = "wipe"
    vim.bo[fbuf].filetype = "markdown"
    vim.api.nvim_buf_set_lines(fbuf, 0, -1, false, lines)
    local config = {
        relative = "win",
        win = source_win,
        bufpos = { last, 0 },
        row = 1,
        col = 0,
        width = math.max(
            20,
            math.min(60, vim.api.nvim_win_get_width(source_win) - vim.fn.getwininfo(source_win)[1].textoff - 2)
        ),
        height = math.min(10, math.max(3, #lines)),
        style = "minimal",
        border = "rounded",
        title = " annotation ",
    }
    local top = vim.fn.line("w0", source_win)
    if last + 1 < top or last + 1 > vim.fn.line("w$", source_win) then
        config.bufpos = nil
        config.row = math.max(0, math.min(vim.api.nvim_win_get_height(source_win) - 1, last + 2 - top))
    end
    local win = vim.api.nvim_open_win(fbuf, true, config)
    local done = false
    local function close()
        vim.cmd("stopinsert")
        if vim.api.nvim_win_is_valid(win) then
            vim.api.nvim_win_close(win, true)
        end
        if vim.api.nvim_win_is_valid(source_win) then
            vim.api.nvim_set_current_win(source_win)
            pcall(vim.api.nvim_win_set_cursor, source_win, cursor)
        end
    end
    local function save()
        done = true
        local typed = vim.api.nvim_buf_get_lines(fbuf, 0, -1, false)
        while #typed > 0 and not typed[#typed]:match("%S") do
            typed[#typed] = nil
        end
        if vim.api.nvim_buf_is_valid(buf) then
            local live_first, live_last
            if mark then
                live_first, live_last = range(buf, mark)
                if not live_first then
                    mark = nil
                end
            end
            local rows = vim.api.nvim_buf_line_count(buf) - 1
            local save_first, save_last = live_first or first, live_last or last
            M.set(buf, math.min(save_first, rows), math.min(save_last, rows), table.concat(typed, "\n"), mark)
        end
        close()
    end
    local function cancel()
        done = true
        close()
    end
    vim.keymap.set("n", "<C-s>", save, { buffer = fbuf })
    vim.keymap.set("i", "<C-s>", function()
        vim.cmd("stopinsert")
        vim.schedule(save)
    end, { buffer = fbuf })
    vim.keymap.set("n", "<CR>", save, { buffer = fbuf })
    vim.keymap.set("n", "q", cancel, { buffer = fbuf })
    vim.keymap.set("n", "<Esc>", cancel, { buffer = fbuf })
    vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI" }, {
        buffer = fbuf,
        callback = function()
            if vim.api.nvim_win_is_valid(win) then
                vim.api.nvim_win_set_height(win, math.min(10, math.max(3, vim.api.nvim_buf_line_count(fbuf))))
            end
        end,
    })
    vim.api.nvim_create_autocmd({ "WinLeave", "BufWipeout" }, {
        buffer = fbuf,
        callback = function()
            if done then
                return
            end
            done = true
            vim.schedule(function()
                if vim.api.nvim_win_is_valid(win) then
                    vim.api.nvim_win_close(win, true)
                end
            end)
        end,
    })
    if mark then
        vim.api.nvim_win_set_cursor(win, { #lines, #lines[#lines] })
    else
        vim.cmd("startinsert")
    end
    return win, fbuf
end

function M.edit_at_cursor()
    local mode = vim.fn.mode()
    local first = vim.api.nvim_win_get_cursor(0)[1]
    local last = first
    if mode == "v" or mode == "V" or mode == "\22" then
        first = vim.fn.getpos("v")[2]
        first, last = math.min(first, last), math.max(first, last)
        vim.cmd("normal! \27")
    end
    return M.edit(vim.api.nvim_get_current_buf(), first - 1, last - 1)
end

local function jump(step)
    local items = M.list(vim.api.nvim_get_current_buf())
    if #items == 0 then
        return
    end
    local row = vim.api.nvim_win_get_cursor(0)[1] - 1
    local target = step > 0 and items[1] or items[#items]
    for i = step > 0 and 1 or #items, step > 0 and #items or 1, step do
        if (step > 0 and items[i].first > row) or (step < 0 and items[i].first < row) then
            target = items[i]
            break
        end
    end
    vim.api.nvim_win_set_cursor(0, { target.first + 1, 0 })
end

function M.next()
    jump(1)
end

function M.prev()
    jump(-1)
end

function M.delete_at_cursor()
    local buf = vim.api.nvim_get_current_buf()
    local mark = M.at(buf, vim.api.nvim_win_get_cursor(0)[1] - 1)
    if mark then
        M.delete(buf, mark)
    end
end

function M.pick()
    local items = {}
    for _, item in ipairs(M.list()) do
        local name = vim.api.nvim_buf_get_name(item.buf)
        items[#items + 1] = {
            text = item.note,
            line = vim.split(item.note, "\n")[1],
            buf = item.buf,
            file = name ~= "" and name or nil,
            pos = { item.first + 1, 0 },
            end_pos = { item.last + 1, 0 },
        }
    end
    require("snacks").picker({ title = "Annotations", items = items })
end

function M.gutter(win, lnum, virtnum)
    local buf = vim.api.nvim_win_get_buf(win)
    local marks = icons[buf] and icons[buf][lnum - 1]
    if not marks or virtnum >= 0 then
        return
    end
    local total, offset = 0, nil
    for _, mark in ipairs(vim.api.nvim_buf_get_extmarks(buf, -1, { lnum - 1, 0 }, { lnum - 1, -1 }, { details = true })) do
        if mark[4].virt_lines and not mark[4].virt_lines_above then
            if mark[4].ns_id == render_ns then
                offset = total
            end
            total = total + #mark[4].virt_lines
        end
    end
    if offset and marks[total + virtnum + 1 - offset] then
        return "%=%#AgencyAnnotationSign#" .. icon .. "%*"
    end
end

function M.setup()
    vim.keymap.set({ "n", "x" }, "<leader>cc", M.edit_at_cursor, { desc = "Annotate line or selection" })
    vim.keymap.set("n", "<leader>cn", M.next, { desc = "Next annotation" })
    vim.keymap.set("n", "<leader>cp", M.prev, { desc = "Previous annotation" })
    vim.keymap.set("n", "<leader>cd", M.delete_at_cursor, { desc = "Delete annotation" })
    vim.keymap.set("n", "<leader>cl", M.pick, { desc = "List annotations" })
end

return M