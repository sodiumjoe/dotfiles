local review = require("sodium.review")

describe("sodium.review", function()
    before_each(function()
        review.reset()
    end)

    describe("parse_pr_list", function()
        it("parses valid JSON", function()
            local json = vim.json.encode({
                { number = 1, title = "Fix bug", author = { login = "bob" },
                  headRefName = "fix-bug", baseRefName = "main",
                  reviewDecision = "", isDraft = false },
            })
            local items = review.parse_pr_list(json)
            assert.are.equal(1, #items)
            assert.are.equal(1, items[1].number)
            assert.are.equal("Fix bug", items[1].title)
            assert.are.equal("bob", items[1].author)
            assert.are.equal("fix-bug", items[1].headRefName)
            assert.are.equal("main", items[1].baseRefName)
        end)

        it("handles missing author field", function()
            local json = vim.json.encode({
                { number = 2, title = "No author", headRefName = "x", baseRefName = "main" },
            })
            local items = review.parse_pr_list(json)
            assert.are.equal(1, #items)
            assert.are.equal("", items[1].author)
        end)

        it("returns empty for invalid JSON", function()
            assert.are.same({}, review.parse_pr_list("not json"))
        end)

        it("returns empty for nil", function()
            assert.are.same({}, review.parse_pr_list(nil))
        end)

        it("returns empty for empty array", function()
            assert.are.same({}, review.parse_pr_list("[]"))
        end)
    end)

    describe("parse_changed_files", function()
        it("splits newline-delimited output", function()
            local files = review.parse_changed_files("a.lua\nb.lua\nc.lua")
            assert.are.equal(3, #files)
            assert.are.equal("a.lua", files[1])
            assert.are.equal("b.lua", files[2])
            assert.are.equal("c.lua", files[3])
        end)

        it("skips empty lines", function()
            local files = review.parse_changed_files("a.lua\n\nb.lua\n")
            assert.are.equal(2, #files)
        end)

        it("handles nil", function()
            assert.are.same({}, review.parse_changed_files(nil))
        end)

        it("handles empty string", function()
            assert.are.same({}, review.parse_changed_files(""))
        end)
    end)

    describe("reviewed state", function()
        it("tracks reviewed files per PR", function()
            review.set_current_pr({ number = 42 })
            assert.is_false(review.is_reviewed("foo.lua"))
            review.toggle_reviewed("foo.lua")
            assert.is_true(review.is_reviewed("foo.lua"))
            review.toggle_reviewed("foo.lua")
            assert.is_false(review.is_reviewed("foo.lua"))
        end)

        it("isolates state between PRs", function()
            review.set_current_pr({ number = 1 })
            review.toggle_reviewed("a.lua")
            review.set_current_pr({ number = 2 })
            assert.is_false(review.is_reviewed("a.lua"))
        end)

        it("preserves state when switching back", function()
            review.set_current_pr({ number = 1 })
            review.toggle_reviewed("a.lua")
            review.set_current_pr({ number = 2 })
            review.set_current_pr({ number = 1 })
            assert.is_true(review.is_reviewed("a.lua"))
        end)

        it("returns false with no current PR", function()
            assert.is_false(review.is_reviewed("foo.lua"))
        end)

        it("toggle is no-op with no current PR", function()
            review.toggle_reviewed("foo.lua")
            review.set_current_pr({ number = 1 })
            assert.is_false(review.is_reviewed("foo.lua"))
        end)

        it("reset clears everything", function()
            review.set_current_pr({ number = 1 })
            review.toggle_reviewed("a.lua")
            review.reset()
            assert.is_nil(review.get_current_pr())
        end)
    end)
end)