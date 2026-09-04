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

    it("renders metadata and restores only after confirmation", function()
        local sessions = require("sodium.agentic_sessions")
        local original_snacks = _G.Snacks
        local picker_opts
        local preview_lines
        local restored
        local show_count = 0
        _G.Snacks = {
            picker = function(opts)
                picker_opts = opts
            end,
        }
        local current_session = {
            agent = {
                when_ready = function(_, callback)
                    callback()
                end,
                list_sessions = function(_, _, callback)
                    callback({
                        sessions = {
                            {
                                sessionId = "session-1",
                                title = "resume me<environment_info>\n- Project root: /pay/src\n</environment_info>",
                                updatedAt = "2026-09-04T01:02:03Z",
                            },
                        },
                    }, nil)
                end,
            },
            chat_history = { messages = {} },
            load_acp_session = function(_, session_id, title, timestamp)
                restored = { session_id, title, timestamp }
            end,
            widget = {
                show = function()
                    show_count = show_count + 1
                end,
            },
        }

        sessions.show_picker(current_session)
        vim.wait(1000, function()
            return picker_opts ~= nil
        end)
        picker_opts.preview({
            item = picker_opts.items[1],
            preview = {
                reset = function() end,
                set_lines = function(_, lines)
                    preview_lines = lines
                end,
            },
        })
        assert.is_nil(restored)
        assert.are.same("Project root: /pay/src", preview_lines[4])
        picker_opts.confirm({ close = function() end }, picker_opts.items[1])

        _G.Snacks = original_snacks
        assert.are.same({
            "session-1",
            "resume me<environment_info>\n- Project root: /pay/src\n</environment_info>",
            "2026-09-04 01:02",
        }, restored)
        assert.are.equal(1, show_count)
    end)

    it("retains the active-session conflict check", function()
        local sessions = require("sodium.agentic_sessions")
        local original_select = vim.ui.select
        local original_snacks = _G.Snacks
        local conflict_opts
        local conflict_callback
        local restored = false
        vim.ui.select = function(_, opts, callback)
            conflict_opts = opts
            conflict_callback = callback
        end
        _G.Snacks = {
            picker = function(opts)
                opts.confirm({ close = function() end }, opts.items[1])
            end,
        }
        local current_session = {
            session_id = "active",
            chat_history = { messages = { { type = "user", text = "work" } } },
            agent = {
                when_ready = function(_, callback)
                    callback()
                end,
                list_sessions = function(_, _, callback)
                    callback({ sessions = { { sessionId = "saved", title = "saved" } } }, nil)
                end,
            },
            load_acp_session = function()
                restored = true
            end,
            widget = { show = function() end },
        }

        sessions.show_picker(current_session)
        vim.wait(1000, function()
            return conflict_callback ~= nil
        end)
        assert.is_false(conflict_opts.snacks.layout.preview)
        assert.is_false(restored)
        conflict_callback("Clear current session and restore")

        vim.ui.select = original_select
        _G.Snacks = original_snacks
        assert.is_true(restored)
    end)

    it("reports list failures and empty session lists", function()
        local sessions = require("sodium.agentic_sessions")
        local original_snacks = _G.Snacks
        local original_logger = package.loaded["agentic.utils.logger"]
        local notifications = {}
        local picker_opened = false
        package.loaded["agentic.utils.logger"] = {
            notify = function(message, level)
                notifications[#notifications + 1] = { message, level }
            end,
        }
        _G.Snacks = {
            picker = function()
                picker_opened = true
            end,
        }

        local function current_session(result, err)
            return {
                agent = {
                    when_ready = function(_, callback)
                        callback()
                    end,
                    list_sessions = function(_, _, callback)
                        callback(result, err)
                    end,
                },
            }
        end

        sessions.show_picker(current_session(nil, { message = "provider error" }))
        sessions.show_picker(current_session({ sessions = {} }, nil))

        package.loaded["agentic.utils.logger"] = original_logger
        _G.Snacks = original_snacks
        assert.is_false(picker_opened)
        assert.are.same({
            { "Failed to list sessions: provider error", vim.log.levels.WARN },
            { "No saved sessions found", vim.log.levels.INFO },
        }, notifications)
    end)
end)
