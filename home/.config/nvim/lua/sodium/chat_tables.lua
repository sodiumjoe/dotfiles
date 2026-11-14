local Layout = require("sodium.table_layout")
local M = {}

local ns = vim.api.nvim_create_namespace("sodium_chat_tables")
local tool_ns = vim.api.nvim_create_namespace("agentic_tool_blocks")
local thinking_ns = vim.api.nvim_create_namespace("agentic_thinking")
local states = rawget(_G, "__sodium_chat_tables") or {}
rawset(_G, "__sodium_chat_tables", states)
local query

local function tables_query()
    query = query or vim.treesitter.query.parse("markdown", "(pipe_table) @table")
    return query
end

local function split_row(line)
    local body = vim.trim(line or "")
    if body:sub(1, 1) == "|" then body = body:sub(2) end
    if body:sub(-1) == "|" and body:sub(-2, -2) ~= "\\" then body = body:sub(1, -2) end
    local cells, current, index = {}, {}, 1
    while index <= #body do
        local char = body:sub(index, index)
        if char == "\\" and body:sub(index + 1, index + 1) == "|" then
            current[#current + 1] = "\\|"
            index = index + 2
        elseif char == "|" then
            cells[#cells + 1] = vim.trim(table.concat(current))
            current, index = {}, index + 1
        else
            current[#current + 1] = char
            index = index + 1
        end
    end
    cells[#cells + 1] = vim.trim(table.concat(current))
    return cells
end

local function alignment(cell)
    local left, right = false, false
    for mark in cell:iter_children() do
        if mark:type() == "pipe_table_align_left" then left = true end
        if mark:type() == "pipe_table_align_right" then right = true end
    end
    return left and right and "center" or right and "right" or "left"
end

local function parse_table(buf, node)
    local tbl, last = { header = {}, align = {}, rows = {} }, (node:range())
    for child in node:iter_children() do
        local kind = child:type()
        local row, col = child:range()
        local line = (vim.api.nvim_buf_get_lines(buf, row, row + 1, false)[1] or ""):sub(col + 1)
        if kind == "pipe_table_header" then
            tbl.header = split_row(line)
        elseif kind == "pipe_table_row" then
            tbl.rows[#tbl.rows + 1] = split_row(line)
        elseif kind == "pipe_table_delimiter_row" then
            for cell in child:iter_children() do
                if cell:type() == "pipe_table_delimiter_cell" then tbl.align[#tbl.align + 1] = alignment(cell) end
            end
        end
        if kind:match("^pipe_table_") then last = math.max(last, row) end
    end
    return tbl, last
end

local function covered(buf, namespace, row)
    return vim.api.nvim_buf_get_extmarks(buf, namespace, { row, 0 }, { row, -1 }, { overlap = true, limit = 1 })[1]
end

local function eligible(buf, first)
    if first == 0 or covered(buf, tool_ns, first) or covered(buf, tool_ns, first - 1) then return false end
    local inside, above = covered(buf, thinking_ns, first), covered(buf, thinking_ns, first - 1)
    return not inside or (above ~= nil and above[1] == inside[1])
end

local function width_for(buf)
    local width
    for _, win in ipairs(vim.fn.win_findbuf(buf)) do
        local info = vim.fn.getwininfo(win)[1]
        local available = info.width - info.textoff
        width = width and math.min(width, available) or available
    end
    return width
end

local function draw(buf, state, first, last, tbl, width)
    vim.api.nvim_buf_clear_namespace(buf, ns, first - 1, last + 1)
    local lines = width and Layout.render(tbl, width) or nil
    local anchor = vim.api.nvim_buf_set_extmark(buf, ns, first - 1, 0, lines and { virt_lines = lines } or {})
    state.tables[anchor] = { tbl = tbl, count = last - first + 1 }
    if not lines then return end
    for row = first, last do vim.api.nvim_buf_set_extmark(buf, ns, row, 0, { conceal_lines = "" }) end
end

local function prune(buf, state)
    for anchor in pairs(state.tables) do
        if not vim.api.nvim_buf_get_extmark_by_id(buf, ns, anchor, {})[1] then state.tables[anchor] = nil end
    end
end

local function render_node(buf, state, node, width)
    local first = (node:range())
    local tbl, last = parse_table(buf, node)
    if eligible(buf, first) then
        draw(buf, state, first, last, tbl, width)
    else
        vim.api.nvim_buf_clear_namespace(buf, ns, math.max(first - 1, 0), last + 1)
    end
end

function M.relayout(buf)
    local state = states[buf]
    if not state or not vim.api.nvim_buf_is_valid(buf) then return end
    prune(buf, state)
    local width, entries = width_for(buf), {}
    if width == state.width then return end
    state.width = width
    for anchor, entry in pairs(state.tables) do entries[#entries + 1] = { anchor, entry } end
    for _, item in ipairs(entries) do
        local position = vim.api.nvim_buf_get_extmark_by_id(buf, ns, item[1], {})
        if position[1] then
            local first = position[1] + 1
            local ok, err = pcall(draw, buf, state, first, first + item[2].count - 1, item[2].tbl, width)
            if not ok then require("agentic.utils.logger").debug("chat table", err) end
        end
    end
    prune(buf, state)
end

function M.update(buf)
    local state = states[buf]
    if not state then return end
    state.scheduled = false
    if not vim.api.nvim_buf_is_valid(buf) then
        states[buf] = nil
        return
    end
    local tree = state.parser:trees()[1]
    if not tree then return end
    local count, width, dirty = vim.api.nvim_buf_line_count(buf), width_for(buf), state.dirty
    state.dirty, state.width = {}, width
    for _, range in ipairs(dirty) do
        local first, last = range[1], math.min(range[2], count - 1)
        if first <= last then
            vim.api.nvim_buf_clear_namespace(buf, ns, first, last + 1)
            for _, node in tables_query():iter_captures(tree:root(), buf, first, math.min(last + 2, count)) do
                local ok, err = pcall(render_node, buf, state, node, width)
                if not ok then require("agentic.utils.logger").debug("chat table", err) end
            end
        end
    end
    prune(buf, state)
end

function M.changed(buf, parser, changes)
    local state = states[buf]
    if not state or state.parser ~= parser then return end
    for _, change in ipairs(changes) do state.dirty[#state.dirty + 1] = { change[1], change[4] } end
    if state.scheduled then return end
    state.scheduled = true
    vim.schedule(function() require("sodium.chat_tables").update(buf) end)
end

function M.attach(buf)
    if not vim.api.nvim_buf_is_valid(buf) then return end
    local ok, parser = pcall(vim.treesitter.get_parser, buf, "markdown")
    if not ok or not parser then return end
    if states[buf] and states[buf].parser == parser then return end
    states[buf] = { parser = parser, dirty = { { 0, vim.api.nvim_buf_line_count(buf) } }, scheduled = false, tables = {} }
    parser:register_cbs({
        on_changedtree = function(changes) require("sodium.chat_tables").changed(buf, parser, changes) end,
        on_bytes = function(_, _, start_row, _, _, _, _, _, new_row)
            require("sodium.chat_tables").changed(buf, parser, { { start_row, 0, 0, start_row + new_row, 0, 0 } })
        end,
        on_detach = function()
            if states[buf] and states[buf].parser == parser then states[buf] = nil end
        end,
    })
    M.changed(buf, parser, {})
end

function M.setup()
    local group = vim.api.nvim_create_augroup("SodiumChatTables", { clear = true })
    vim.api.nvim_create_autocmd("FileType", {
        group = group,
        pattern = "AgenticChat",
        callback = function(event) require("sodium.chat_tables").attach(event.buf) end,
    })
    vim.api.nvim_create_autocmd("BufWipeout", {
        group = group,
        callback = function(event) states[event.buf] = nil end,
    })
    vim.api.nvim_create_autocmd("WinResized", {
        group = group,
        callback = function()
            for _, win in ipairs(vim.v.event.windows or {}) do
                if vim.api.nvim_win_is_valid(win) then
                    local buf = vim.api.nvim_win_get_buf(win)
                    local state = states[buf]
                    if state and not state.resizing then
                        state.resizing = true
                        vim.schedule(function()
                            state.resizing = false
                            require("sodium.chat_tables").relayout(buf)
                        end)
                    end
                end
            end
        end,
    })
    vim.api.nvim_create_autocmd("BufWinEnter", {
        group = group,
        callback = function(event)
            if states[event.buf] then require("sodium.chat_tables").relayout(event.buf) end
        end,
    })
    for _, buf in ipairs(vim.api.nvim_list_bufs()) do
        if vim.api.nvim_buf_is_loaded(buf) and vim.bo[buf].filetype == "AgenticChat" then M.attach(buf) end
    end
end

return M