local md = require("sodium.markdown")

describe("sodium.markdown", function()
    describe("get_list_prefix", function()
        it("returns prefix for bullet list", function()
            assert.are.equal("- ", md.get_list_prefix("- item"))
        end)

        it("preserves indentation for bullet list", function()
            assert.are.equal("  - ", md.get_list_prefix("  - item"))
        end)

        it("returns prefix for asterisk list", function()
            assert.are.equal("* ", md.get_list_prefix("* item"))
        end)

        it("increments numbered list with dot", function()
            assert.are.equal("2. ", md.get_list_prefix("1. item"))
        end)

        it("increments numbered list with paren", function()
            assert.are.equal("4) ", md.get_list_prefix("3) item"))
        end)

        it("returns unchecked checkbox for checked task", function()
            assert.are.equal("- [ ] ", md.get_list_prefix("- [x] done"))
        end)

        it("returns unchecked checkbox for in-progress task", function()
            assert.are.equal("- [ ] ", md.get_list_prefix("- [/] progress"))
        end)

        it("returns unchecked checkbox for unchecked task", function()
            assert.are.equal("- [ ] ", md.get_list_prefix("- [ ] task"))
        end)

        it("preserves indentation for checkbox", function()
            assert.are.equal("  - [ ] ", md.get_list_prefix("  - [ ] indented"))
        end)

        it("returns nil for plain text", function()
            assert.is_nil(md.get_list_prefix("plain text"))
        end)

        it("returns nil for empty string", function()
            assert.is_nil(md.get_list_prefix(""))
        end)
    end)

    describe("has_text_after_prefix", function()
        it("returns true for bullet with text", function()
            assert.is_true(md.has_text_after_prefix("- item"))
        end)

        it("returns false for bare bullet", function()
            assert.is_false(md.has_text_after_prefix("- "))
        end)

        it("returns true for checkbox with text", function()
            assert.is_true(md.has_text_after_prefix("- [ ] task"))
        end)

        it("returns false for bare checkbox", function()
            assert.is_false(md.has_text_after_prefix("- [ ] "))
        end)

        it("returns true for numbered list with text", function()
            assert.is_true(md.has_text_after_prefix("1. first"))
        end)

        it("returns false for bare numbered list", function()
            assert.is_false(md.has_text_after_prefix("1. "))
        end)

        it("returns true for asterisk with text", function()
            assert.is_true(md.has_text_after_prefix("* stuff"))
        end)

        it("returns false for bare asterisk", function()
            assert.is_false(md.has_text_after_prefix("* "))
        end)
    end)
end)