describe("agentic session picker data", function()
    before_each(function()
        package.loaded["sodium.agentic_sessions"] = nil
    end)

    it("extracts a clean title and structured metadata", function()
        local sessions = require("sodium.agentic_sessions")
        local item = sessions.normalize_session({
            sessionId = "01a069a5-162a-70b0-9df2-d668ed495c35",
            updatedAt = "2026-09-04T01:02:03Z",
            title = "use luna subagents to execute this plan<environment_info>\n"
                .. "- Platform: Linux-6.8.0-1063-aws-aarch64\n"
                .. "- Shell: /bin/zsh\n"
                .. "- Editor: Neovim 0.12.4\n"
                .. "- Current date: 2026-09-03\n"
                .. "- This is a Git repository.\n"
                .. "- Current branch: moon/vite-hotspot-2\n"
                .. "- Recent commits:\n"
                .. "  - abc123 first commit\n"
                .. "- Project root: /pay/src\n"
                .. "</environment_info>"
                .. "[@2026-09-03-plans-products-availability-leaf.md]"
                .. "(file:///pay/home/owner/stripe/work/projects/vite-dev-server-throughput/"
                .. "2026-09-03-plans-products-availability-leaf.md)",
        })

        assert.are.equal("use luna subagents to execute this plan", item.title)
        assert.are.equal("2026-09-04 01:02", item.updated_at)
        assert.are.equal("/pay/src", item.metadata.project_root)
        assert.are.equal("moon/vite-hotspot-2", item.metadata.branch)
        assert.are.equal("Linux-6.8.0-1063-aws-aarch64", item.metadata.platform)
        assert.are.equal("Neovim 0.12.4", item.metadata.editor)
        assert.are.equal("/bin/zsh", item.metadata.shell)
        assert.are.equal(
            "/pay/home/owner/stripe/work/projects/vite-dev-server-throughput/"
                .. "2026-09-03-plans-products-availability-leaf.md",
            item.metadata.plan
        )
        assert.are.same({
            "use luna subagents to execute this plan",
            "",
            "Updated:      2026-09-04 01:02",
            "Project root: /pay/src",
            "Branch:       moon/vite-hotspot-2",
            "Plan:         /pay/home/owner/stripe/work/projects/vite-dev-server-throughput/"
                .. "2026-09-03-plans-products-availability-leaf.md",
            "",
            "Platform:     Linux-6.8.0-1063-aws-aarch64",
            "Editor:       Neovim 0.12.4",
            "Shell:        /bin/zsh",
            "Session ID:   01a069a5-162a-70b0-9df2-d668ed495c35",
        }, sessions.preview_lines(item))
    end)

    it("falls back to a usable title and omits missing metadata", function()
        local sessions = require("sodium.agentic_sessions")
        local item = sessions.normalize_session({
            sessionId = "plain",
            title = "  plain session  ",
        })

        assert.are.equal("plain session", item.title)
        assert.are.equal("unknown date", item.updated_at)
        assert.are.same({
            "plain session",
            "",
            "Updated:      unknown date",
            "Session ID:   plain",
        }, sessions.preview_lines(item))
    end)

    it("sorts valid timestamps newest-first and preserves fallback order", function()
        local sessions = require("sodium.agentic_sessions")
        local items = sessions.normalize_sessions({
            { sessionId = "older", title = "older", updatedAt = "2026-03-20T14:30:00Z" },
            { sessionId = "invalid", title = "invalid", updatedAt = "not-a-date" },
            { sessionId = "equal-first", title = "equal first", updatedAt = "2026-03-20T14:30:00Z" },
            { sessionId = "equal-second", title = "equal second", updatedAt = "2026-03-20T14:30:00Z" },
            { sessionId = "invalid-range", title = "invalid range", updatedAt = "2026-99-99T25:99:99Z" },
            { sessionId = "newest", title = "newest", updatedAt = "2026-03-21T09:15:00Z" },
            { sessionId = "missing", title = "missing" },
        })

        assert.are.same(
            {
                "newest",
                "older",
                "equal-first",
                "equal-second",
                "invalid",
                "invalid-range",
                "missing",
            },
            vim.tbl_map(function(item)
                return item.session_id
            end, items)
        )
    end)

    it("tolerates incomplete environment blocks and malformed file links", function()
        local sessions = require("sodium.agentic_sessions")
        local item = sessions.normalize_session({
            sessionId = "malformed",
            title = "keep this title<environment_info>\n- Project root: /pay/src\n"
                .. "[@broken.md](file:///pay/home/owner/broken.md",
        })

        assert.are.equal(
            "keep this title<environment_info> - Project root: /pay/src [@broken.md](file:///pay/home/owner/broken.md",
            item.title
        )
        assert.are.same({}, item.metadata)
    end)
end)
