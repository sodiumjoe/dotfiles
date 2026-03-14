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

    describe("previous_branch state", function()
        it("stores and retrieves previous branch", function()
            review.set_previous_branch("main")
            assert.are.equal("main", review.get_previous_branch())
        end)

        it("returns nil by default", function()
            assert.is_nil(review.get_previous_branch())
        end)

        it("reset clears previous branch", function()
            review.set_previous_branch("feature-x")
            review.reset()
            assert.is_nil(review.get_previous_branch())
        end)
    end)

    describe("current_user state", function()
        it("stores and retrieves current user", function()
            review.set_current_user("alice")
            assert.are.equal("alice", review.get_current_user())
        end)

        it("returns nil by default", function()
            assert.is_nil(review.get_current_user())
        end)

        it("reset clears current user", function()
            review.set_current_user("bob")
            review.reset()
            assert.is_nil(review.get_current_user())
        end)
    end)

    describe("parse_gh_comments", function()
        it("parses basic comments", function()
            local json = vim.json.encode({
                { id = 100, path = "foo.lua", line = 10, body = "looks good",
                  user = { login = "alice" }, created_at = "2026-01-01T00:00:00Z" },
            })
            local by_id, files = review.parse_gh_comments(json)
            assert.is_not_nil(by_id["100"])
            assert.are.equal("foo.lua", by_id["100"].file)
            assert.are.equal(10, by_id["100"].line)
            assert.are.equal("alice: looks good", by_id["100"].body)
            assert.are.equal("comment", by_id["100"].kind)
            assert.is_not_nil(files["foo.lua"])
            assert.are.equal(1, #files["foo.lua"])
        end)

        it("groups replies under parent", function()
            local json = vim.json.encode({
                { id = 100, path = "foo.lua", line = 10, body = "nit",
                  user = { login = "alice" }, created_at = "2026-01-01T00:00:00Z" },
                { id = 101, path = "foo.lua", line = 10, body = "fixed",
                  user = { login = "bob" }, created_at = "2026-01-01T01:00:00Z",
                  in_reply_to_id = 100 },
            })
            local by_id, _ = review.parse_gh_comments(json)
            assert.are.equal("comment", by_id["100"].kind)
            assert.are.equal(1, #by_id["100"].reply_ids)
            assert.are.equal("101", by_id["100"].reply_ids[1])
            assert.are.equal("reply", by_id["101"].kind)
            assert.are.equal("100", by_id["101"].root_id)
        end)

        it("skips comments with nil line (outdated)", function()
            local json = vim.json.encode({
                { id = 200, path = "bar.lua", line = vim.NIL, body = "outdated",
                  user = { login = "alice" }, created_at = "2026-01-01T00:00:00Z" },
            })
            local by_id, files = review.parse_gh_comments(json)
            assert.is_nil(by_id["200"])
            assert.is_nil(files["bar.lua"])
        end)

        it("returns empty for nil input", function()
            local by_id, files = review.parse_gh_comments(nil)
            assert.are.same({}, by_id)
            assert.are.same({}, files)
        end)

        it("returns empty for invalid JSON", function()
            local by_id, files = review.parse_gh_comments("not json")
            assert.are.same({}, by_id)
            assert.are.same({}, files)
        end)

        it("returns empty for empty array", function()
            local by_id, files = review.parse_gh_comments("[]")
            assert.are.same({}, by_id)
            assert.are.same({}, files)
        end)
    end)

    describe("filter_local_comments", function()
        it("returns comments by current user with non-numeric IDs", function()
            local data = {
                comments = {
                    ["abc-123"] = { actor = "alice", file = "foo.lua", line = 1, body = "local comment" },
                    ["456"] = { actor = "alice", file = "bar.lua", line = 2, body = "github comment" },
                    ["def-789"] = { actor = "bob", file = "baz.lua", line = 3, body = "someone else" },
                },
            }
            local result = review.filter_local_comments(data, "alice")
            assert.are.equal(1, #result)
            assert.are.equal("local comment", result[1].body)
        end)

        it("matches author field from nvim-comment-overlay", function()
            local data = {
                comments = {
                    ["20260313_a1b2"] = { author = "alice", file = "foo.lua", line_start = 5, body = "overlay comment" },
                },
            }
            local result = review.filter_local_comments(data, "alice")
            assert.are.equal(1, #result)
            assert.are.equal("overlay comment", result[1].body)
        end)

        it("returns empty when no local comments", function()
            local data = {
                comments = {
                    ["100"] = { actor = "alice", file = "foo.lua", line = 1, body = "from github" },
                },
            }
            local result = review.filter_local_comments(data, "alice")
            assert.are.equal(0, #result)
        end)

        it("returns empty for nil data", function()
            assert.are.same({}, review.filter_local_comments(nil, "alice"))
        end)

        it("returns empty for nil user", function()
            local data = { comments = { ["abc"] = { actor = "alice" } } }
            assert.are.same({}, review.filter_local_comments(data, nil))
        end)
    end)
end)