local M = {}

M.MIN_WIDTH = 8
M.HEAD = "RenderMarkdownTableHead"
M.ROW = "RenderMarkdownTableRow"

local INLINE = {
    { pattern = "^`([^`]+)`", hl = "RenderMarkdownCodeInline" },
    { pattern = "^%*%*(.-)%*%*", hl = "@markup.strong" },
    { pattern = "^__(.-)__", hl = "@markup.strong" },
    { pattern = "^%*([^%s%*][^%*]-[^%s%*])%*", hl = "@markup.italic" },
    { pattern = "^%*([^%s%*])%*", hl = "@markup.italic" },
    { pattern = "^%[([^%]]+)%]%b()", hl = "RenderMarkdownLink" },
}

function M.segments(text)
    local out, plain, index = {}, {}, 1
    local function flush()
        if #plain > 0 then
            out[#out + 1] = { table.concat(plain) }
            plain = {}
        end
    end
    while index <= #text do
        local matched = false
        if text:sub(index, index + 1) == "\\|" then
            plain[#plain + 1] = "|"
            index, matched = index + 2, true
        else
            for _, rule in ipairs(INLINE) do
                local _, finish, inner = text:find(rule.pattern, index)
                if finish and inner ~= "" then
                    flush()
                    out[#out + 1] = { (inner:gsub("\\|", "|")), rule.hl }
                    index, matched = finish + 1, true
                    break
                end
            end
        end
        if not matched then
            plain[#plain + 1] = text:sub(index, index)
            index = index + 1
        end
    end
    flush()
    return out
end

local function chars(segments)
    local out = {}
    for _, segment in ipairs(segments) do
        for char in segment[1]:gmatch("[%z\1-\127\194-\244][\128-\191]*") do
            if char == "\t" then char = " " end
            out[#out + 1] = { char, segment[2], #char == 1 and 1 or vim.fn.strdisplaywidth(char) }
        end
    end
    return out
end

local function size_of(cs)
    local size = 0
    for _, char in ipairs(cs) do size = size + char[3] end
    return size
end

local function wrap(cs, width)
    local lines, line, used, index = {}, {}, 0, 1
    local function push()
        lines[#lines + 1] = line
        line, used = {}, 0
    end
    while index <= #cs do
        local stop = index
        while stop <= #cs and cs[stop][1] ~= " " do stop = stop + 1 end
        local word = {}
        for k = index, stop - 1 do word[#word + 1] = cs[k] end
        local size = size_of(word)
        if size > 0 then
            if used > 0 and used + 1 + size <= width then
                local previous = line[#line][2]
                line[#line + 1] = { " ", previous == word[1][2] and previous or nil, 1 }
                vim.list_extend(line, word)
                used = used + 1 + size
            elseif size <= width then
                if used > 0 then push() end
                vim.list_extend(line, word)
                used = size
            else
                if used > 0 then push() end
                for _, char in ipairs(word) do
                    if used + char[3] > width then push() end
                    line[#line + 1] = char
                    used = used + char[3]
                end
            end
        end
        index = stop + 1
    end
    if used > 0 or #lines == 0 then push() end
    return lines
end

local function chunks(cs)
    local out = {}
    for _, char in ipairs(cs) do
        local last = out[#out]
        if last and last[2] == char[2] then
            last[1] = last[1] .. char[1]
        else
            out[#out + 1] = { char[1], char[2] }
        end
    end
    return out
end

function M.column_widths(natural, available)
    local budget, total, floor_total = available - (3 * #natural + 1), 0, 0
    for _, width in ipairs(natural) do
        total = total + width
        floor_total = floor_total + math.min(width, M.MIN_WIDTH)
    end
    if total <= budget then return vim.deepcopy(natural) end
    if floor_total > budget then return nil end
    local widths, flexible, remaining = {}, {}, budget
    for index = 1, #natural do flexible[index] = index end
    local settled = true
    while settled and #flexible > 0 do
        settled = false
        local share = remaining / #flexible
        for k = #flexible, 1, -1 do
            local index = flexible[k]
            if natural[index] <= share then
                widths[index] = natural[index]
                remaining = remaining - natural[index]
                table.remove(flexible, k)
                settled = true
            end
        end
    end
    local flex_total, used = 0, 0
    for _, index in ipairs(flexible) do flex_total = flex_total + natural[index] end
    for _, index in ipairs(flexible) do
        widths[index] = math.min(natural[index], math.max(M.MIN_WIDTH, math.floor(remaining * natural[index] / flex_total)))
        used = used + widths[index]
    end
    while used > remaining do
        local widest
        for _, index in ipairs(flexible) do
            if widths[index] > math.min(natural[index], M.MIN_WIDTH) and (not widest or widths[index] > widths[widest]) then widest = index end
        end
        widths[widest] = widths[widest] - 1
        used = used - 1
    end
    local turn = 0
    while used < remaining do
        local index = flexible[turn % #flexible + 1]
        if widths[index] < natural[index] then
            widths[index] = widths[index] + 1
            used = used + 1
        end
        turn = turn + 1
    end
    return widths
end

local function rule(widths, left, middle, right, hl)
    local parts = { left }
    for index, width in ipairs(widths) do
        parts[#parts + 1] = string.rep("─", width + 2)
        parts[#parts + 1] = index < #widths and middle or right
    end
    return { { table.concat(parts), hl } }
end

local function row_lines(cells, widths, align, hl)
    local wrapped, height = {}, 1
    for index, width in ipairs(widths) do
        wrapped[index] = wrap(chars(M.segments(cells[index] or "")), width)
        height = math.max(height, #wrapped[index])
    end
    local lines = {}
    for row = 1, height do
        local line = { { "│", hl } }
        for index, width in ipairs(widths) do
            local cs = wrapped[index][row] or {}
            local gap = width - size_of(cs)
            local left = align[index] == "right" and gap or align[index] == "center" and math.floor(gap / 2) or 0
            line[#line + 1] = { string.rep(" ", left + 1) }
            vim.list_extend(line, chunks(cs))
            line[#line + 1] = { string.rep(" ", gap - left + 1) }
            line[#line + 1] = { "│", hl }
        end
        lines[#lines + 1] = line
    end
    return lines, height
end

function M.render(tbl, width)
    local count, natural = math.max(#tbl.header, #tbl.align), {}
    for index = 1, count do
        local widest = 1
        for _, cells in ipairs({ tbl.header, unpack(tbl.rows) }) do
            widest = math.max(widest, size_of(chars(M.segments(cells[index] or ""))))
        end
        natural[index] = widest
    end
    local widths = M.column_widths(natural, width)
    if not widths then return nil end
    local body, wrapped = {}, false
    for _, cells in ipairs(tbl.rows) do
        local lines, height = row_lines(cells, widths, tbl.align, M.ROW)
        body[#body + 1] = lines
        wrapped = wrapped or height > 1
    end
    local out = { rule(widths, "┌", "┬", "┐", M.HEAD) }
    vim.list_extend(out, (row_lines(tbl.header, widths, tbl.align, M.HEAD)))
    out[#out + 1] = rule(widths, "├", "┼", "┤", M.HEAD)
    for index, lines in ipairs(body) do
        if wrapped and index > 1 then out[#out + 1] = rule(widths, "├", "┼", "┤", M.ROW) end
        vim.list_extend(out, lines)
    end
    out[#out + 1] = rule(widths, "└", "┴", "┘", M.ROW)
    return out
end

return M