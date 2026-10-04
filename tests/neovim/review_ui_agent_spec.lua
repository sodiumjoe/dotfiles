local review = require("sodium.review")
local review_ui = require("sodium.review_ui")

describe("sodium.review_ui agent integration", function()
    local old_agency, old_registry, old_notify
    before_each(function()
        old_agency = package.loaded["sodium.agency"]
        old_registry = package.loaded["agentic.session_registry"]
        old_notify = vim.notify
        package.loaded["agentic.session_registry"] = { get_session_for_tab_page = function()
            error("unexpected native provider lookup")
        end }
    end)
    after_each(function()
        package.loaded["sodium.agency"] = old_agency
        package.loaded["agentic.session_registry"] = old_registry
        vim.notify = old_notify
    end)
    it("submits through Agency without touching native sessions", function()
        local submitted
        package.loaded["sodium.agency"] = { submit_text = function(text, opts)
            submitted = text
            assert.is_false(opts.focus_prompt)
            return true
        end }
        assert.is_true(review_ui.send_agent_command("/neovim-review self abc123"))
        assert.are.equal("/neovim-review self abc123", submitted)
    end)
    it("reports unknown delivery without retrying", function()
        local notification, calls = nil, 0
        vim.notify = function(message) notification = message end
        package.loaded["sodium.agency"] = { submit_text = function(_, _, callback)
            calls = calls + 1
            callback({ state = "unknown", error = { message = "delivery unavailable" } })
            return true
        end }
        assert.is_true(review_ui.send_agent_command("review"))
        assert.are.equal(1, calls)
        assert.is_truthy(notification:find("delivery unavailable", 1, true))
    end)
    it("reports synchronous Agency errors", function()
        local notification
        vim.notify = function(message) notification = message end
        package.loaded["sodium.agency"] = { submit_text = function() error("Agency unavailable") end }
        assert.is_false(review_ui.send_agent_command("review"))
        assert.is_truthy(notification:find("Agency unavailable", 1, true))
    end)
end)

describe(":Review agent overview", function()
    local originals

    before_each(function()
        originals = {
            start_self_review = review.start_self_review,
            get_session = review.get_session,
            show_help = review_ui.show_help,
            open_file_picker = review_ui.open_file_picker,
            send_agent_command = review_ui.send_agent_command,
        }
    end)

    after_each(function()
        review.start_self_review = originals.start_self_review
        review.get_session = originals.get_session
        review_ui.show_help = originals.show_help
        review_ui.open_file_picker = originals.open_file_picker
        review_ui.send_agent_command = originals.send_agent_command
        review.reset()
    end)

    local function stub_success(events, seen)
        review.start_self_review = function(base)
            seen.requested_base = base
            return true
        end
        review.get_session = function()
            return { mode = "self", base_ref = "resolved-merge-base", toplevel = "/repo" }
        end
        review_ui.show_help = function()
            events[#events + 1] = "help"
        end
        review_ui.open_file_picker = function()
            events[#events + 1] = "picker"
        end
        review_ui.send_agent_command = function(command)
            events[#events + 1] = "agent"
            seen.command = command
            return false
        end
    end

    it("opens the agent without the picker after bare Review starts", function()
        local events = {}
        local seen = {}
        stub_success(events, seen)

        vim.cmd("Review")

        assert.is_nil(seen.requested_base)
        assert.are.equal("/neovim-review self resolved-merge-base", seen.command)
        assert.are.same({ "help", "agent" }, events)
    end)

    it("opens the agent without the picker after explicit base selection", function()
        local events = {}
        local seen = {}
        stub_success(events, seen)

        vim.cmd("Review HEAD~2")

        assert.are.equal("HEAD~2", seen.requested_base)
        assert.are.equal("/neovim-review self resolved-merge-base", seen.command)
        assert.are.same({ "help", "agent" }, events)
    end)

    it("does not open UI or submit when self-review initialization fails", function()
        local events = {}
        review.start_self_review = function()
            return false
        end
        review_ui.show_help = function()
            events[#events + 1] = "help"
        end
        review_ui.open_file_picker = function()
            events[#events + 1] = "picker"
        end
        review_ui.send_agent_command = function()
            events[#events + 1] = "agent"
            return true
        end

        vim.cmd("Review")

        assert.are.same({}, events)
    end)
end)