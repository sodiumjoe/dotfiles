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

    describe("parse_file_diffs", function()
        it("splits multi-file diff", function()
            local diff = table.concat({
                "diff --git a/foo.lua b/foo.lua",
                "index abc..def 100644",
                "--- a/foo.lua",
                "+++ b/foo.lua",
                "@@ -1,3 +1,4 @@",
                " line1",
                "+added",
                "diff --git a/bar.lua b/bar.lua",
                "index 111..222 100644",
                "--- a/bar.lua",
                "+++ b/bar.lua",
                "@@ -1 +1 @@",
                "-old",
                "+new",
            }, "\n")
            local diffs, files = review.parse_file_diffs(diff)
            assert.are.equal(2, #files)
            assert.are.equal("foo.lua", files[1])
            assert.are.equal("bar.lua", files[2])
            assert.is_truthy(diffs["foo.lua"]:find("+added"))
            assert.is_truthy(diffs["bar.lua"]:find("+new"))
        end)

        it("handles single file diff", function()
            local diff = "diff --git a/x.lua b/x.lua\n--- a/x.lua\n+++ b/x.lua\n@@ -1 +1 @@\n-a\n+b"
            local diffs, files = review.parse_file_diffs(diff)
            assert.are.equal(1, #files)
            assert.are.equal("x.lua", files[1])
            assert.is_truthy(diffs["x.lua"])
        end)

        it("handles new file", function()
            local diff = "diff --git a/new.lua b/new.lua\nnew file mode 100644\n--- /dev/null\n+++ b/new.lua\n@@ -0,0 +1 @@\n+content"
            local diffs, files = review.parse_file_diffs(diff)
            assert.are.equal(1, #files)
            assert.are.equal("new.lua", files[1])
            assert.is_truthy(diffs["new.lua"]:find("+content"))
        end)

        it("returns empty for nil", function()
            local diffs, files = review.parse_file_diffs(nil)
            assert.are.same({}, diffs)
            assert.are.same({}, files)
        end)

        it("returns empty for empty string", function()
            local diffs, files = review.parse_file_diffs("")
            assert.are.same({}, diffs)
            assert.are.same({}, files)
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