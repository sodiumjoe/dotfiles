local Layout = require("sodium.table_layout")

local function text(line)
    local parts = {}
    for _, chunk in ipairs(line) do parts[#parts + 1] = chunk[1] end
    return table.concat(parts)
end

local function texts(lines)
    return vim.tbl_map(text, lines)
end

local function tbl(header, rows, align)
    return { header = header, rows = rows, align = align or vim.tbl_map(function() return "left" end, header) }
end

describe("Table layout", function()
    it("keeps natural widths when the table fits", function()
        assert.are.same({
            "┌───┬─────┐",
            "│ A │ Bee │",
            "├───┼─────┤",
            "│ 1 │ 2   │",
            "└───┴─────┘",
        }, texts(Layout.render(tbl({ "A", "Bee" }, { { "1", "2" } }), 80)))
    end)

    it("wraps a long cell inside its column and grows the row to the tallest cell", function()
        assert.are.same({
            "┌──────┬─────────────────────┐",
            "│ Key  │ Notes               │",
            "├──────┼─────────────────────┤",
            "│ wrap │ breaks long rows    │",
            "│      │ across screen lines │",
            "└──────┴─────────────────────┘",
        }, texts(Layout.render(tbl({ "Key", "Notes" }, { { "wrap", "breaks long rows across screen lines" } }), 30)))
    end)

    it("separates body rows with a rule when any row wraps", function()
        local lines = texts(Layout.render(tbl({ "Key", "Notes" }, {
            { "one", "short" },
            { "two", "breaks long rows across screen lines" },
        }), 30))
        assert.are.equal(lines[3], lines[5])
    end)

    it("shares the remaining width in proportion and keeps the minimum", function()
        assert.are.same({ 10, 14, 26 }, Layout.column_widths({ 10, 30, 60 }, 60))
        assert.are.same({ 4, 8, 8 }, Layout.column_widths({ 4, 50, 50 }, 30))
    end)

    it("returns nil when even minimum widths cannot fit", function()
        assert.is_nil(Layout.column_widths({ 20, 20, 20, 20 }, 44))
        assert.is_nil(Layout.render(tbl({ "a", "b", "c", "d" }, { { string.rep("x", 20), string.rep("x", 20), string.rep("x", 20), string.rep("x", 20) } }), 44))
    end)

    it("aligns cells from the delimiter row", function()
        local lines = texts(Layout.render(tbl({ "Left", "Mid", "Right" }, { { "a", "b", "c" } }, { "left", "center", "right" }), 80))
        assert.are.equal("│ Left │ Mid │ Right │", lines[2])
        assert.are.equal("│ a    │  b  │     c │", lines[4])
    end)

    it("renders inline code, bold, italics and links without their markers", function()
        assert.are.same({
            { "run " }, { "ls -l", "RenderMarkdownCodeInline" }, { " then " }, { "stop", "@markup.strong" },
            { " or " }, { "wait", "@markup.italic" }, { " see " }, { "docs", "RenderMarkdownLink" }, { " a|b snake_case" },
        }, Layout.segments("run `ls -l` then **stop** or *wait* see [docs](http://x) a\\|b snake_case"))
        assert.are.same({ { "a | b", "RenderMarkdownCodeInline" } }, Layout.segments("`a \\| b`"))
        assert.are.same({ { "2 * 3 * 4" } }, Layout.segments("2 * 3 * 4"))
        local found
        for _, chunk in ipairs(Layout.render(tbl({ "Cmd" }, { { "`ls -l`" } }), 80)[4]) do
            if chunk[2] == "RenderMarkdownCodeInline" then found = chunk[1] end
        end
        assert.are.equal("ls -l", found)
    end)

    it("measures wide characters by display width", function()
        local lines = texts(Layout.render(tbl({ "名前", "x" }, { { "🙂", "y" } }), 80))
        for _, line in ipairs(lines) do assert.are.equal(vim.fn.strdisplaywidth(lines[1]), vim.fn.strdisplaywidth(line)) end
    end)

    it("splits a token longer than its column without breaking the borders", function()
        local url = "https://example.com/a/very/long/path/segment"
        local lines = texts(Layout.render(tbl({ "Link" }, { { url } }), 20))
        local joined = {}
        for index, line in ipairs(lines) do
            assert.are.equal(20, vim.fn.strdisplaywidth(line))
            if index > 3 and index < #lines then joined[#joined + 1] = vim.trim(line:gsub("│", "")) end
        end
        assert.are.equal(url, table.concat(joined))
    end)
end)