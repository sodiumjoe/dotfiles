local au = require("sodium.agentic_utils")

describe("sodium.agentic_utils", function()
    describe("parse_task_items", function()
        it("parses a single well-formed line", function()
            local stdout = "file.md\t5\t \tProject\tDo thing"
            local items = au.parse_task_items(stdout)
            assert.are.equal(1, #items)
            assert.are.equal("file.md", items[1].file)
            assert.are.equal(5, items[1].line_num)
            assert.are.equal(" ", items[1].state)
            assert.are.equal("Project", items[1].title)
            assert.are.equal("Do thing", items[1].description)
            assert.are.equal("Do thing", items[1].text)
        end)

        it("parses multiple lines", function()
            local stdout = "a.md\t1\t \tP1\tTask one\nb.md\t2\t/\tP2\tTask two"
            local items = au.parse_task_items(stdout)
            assert.are.equal(2, #items)
            assert.are.equal("a.md", items[1].file)
            assert.are.equal("b.md", items[2].file)
            assert.are.equal("/", items[2].state)
        end)

        it("returns empty table for empty string", function()
            assert.are.same({}, au.parse_task_items(""))
        end)

        it("returns empty table for nil", function()
            assert.are.same({}, au.parse_task_items(nil))
        end)

        it("skips malformed lines", function()
            local stdout = "not enough tabs\nfile.md\t5\t \tProject\tDo thing"
            local items = au.parse_task_items(stdout)
            assert.are.equal(1, #items)
            assert.are.equal("file.md", items[1].file)
        end)

        it("converts line_num to number", function()
            local items = au.parse_task_items("f.md\t42\tx\tP\tD")
            assert.are.equal("number", type(items[1].line_num))
            assert.are.equal(42, items[1].line_num)
        end)
    end)

    describe("slugify", function()
        it("lowercases and hyphenates spaces", function()
            assert.are.equal("my-cool-project", au.slugify("My Cool Project"))
        end)

        it("trims leading and trailing dashes", function()
            assert.are.equal("leading-spaces", au.slugify("  leading spaces  "))
        end)

        it("lowercases", function()
            assert.are.equal("uppercase", au.slugify("UPPERCASE"))
        end)

        it("replaces special characters with hyphens", function()
            assert.are.equal("special-chars", au.slugify("special!@#chars"))
        end)

        it("passes through already-slugified strings", function()
            assert.are.equal("already-slugified", au.slugify("already-slugified"))
        end)

        it("strips leading and trailing dashes", function()
            assert.are.equal("dashes", au.slugify("---dashes---"))
        end)
    end)

    describe("state tables", function()
        it("state_cycle maps all three states", function()
            assert.are.equal("in-progress", au.state_cycle[" "])
            assert.are.equal("done", au.state_cycle["/"])
            assert.are.equal("open", au.state_cycle["x"])
        end)

        it("state_char is the inverse of state_cycle", function()
            assert.are.equal("/", au.state_char["in-progress"])
            assert.are.equal("x", au.state_char["done"])
            assert.are.equal(" ", au.state_char["open"])
        end)

        it("round-trips through cycle and char", function()
            for _, c in ipairs({ " ", "/", "x" }) do
                local next_state = au.state_cycle[c]
                local next_char = au.state_char[next_state]
                assert.is_not_nil(next_char, "round-trip failed for '" .. c .. "'")
            end
        end)

        it("state_display covers all states", function()
            assert.are.equal("[ ]", au.state_display[" "])
            assert.are.equal("[/]", au.state_display["/"])
            assert.are.equal("[x]", au.state_display["x"])
        end)
    end)
end)