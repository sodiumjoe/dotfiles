local review = require("sodium.review")
local review_ui = require("sodium.review_ui")

describe("sodium.review_ui agent integration", function()
    local original_registry
    local original_notify
    local original_defer_fn
    local buffers

    local function make_session(session_id, submit_error)
        local input = vim.api.nvim_create_buf(false, true)
        buffers[#buffers + 1] = input
        local state = { shown = 0, submitted = 0 }
        local session = {
            session_id = session_id,
            widget = {
                buf_nrs = { input = input },
                show = function()
                    state.shown = state.shown + 1
                end,
                _submit_input = function()
                    state.submitted = state.submitted + 1
                    if submit_error then
                        error(submit_error)
                    end
                end,
            },
        }
        return session, state, input
    end

    before_each(function()
        original_registry = package.loaded["agentic.session_registry"]
        original_notify = vim.notify
        original_defer_fn = vim.defer_fn
        buffers = {}
    end)

    after_each(function()
        package.loaded["agentic.session_registry"] = original_registry
        vim.notify = original_notify
        vim.defer_fn = original_defer_fn
        for _, buf in ipairs(buffers) do
            if vim.api.nvim_buf_is_valid(buf) then
                vim.api.nvim_buf_delete(buf, { force = true })
            end
        end
        review.reset()
    end)

    it("submits a command to an initialized agent session", function()
        local session, state, input = make_session("session-1")
        package.loaded["agentic.session_registry"] = {
            get_session_for_tab_page = function(_, callback)
                callback(session)
            end,
        }

        assert.is_true(review_ui.send_agent_command("/neovim-review self abc123"))
        assert.are.same(
            { "/neovim-review self abc123" },
            vim.api.nvim_buf_get_lines(input, 0, -1, false)
        )
        assert.are.equal(1, state.shown)
        assert.are.equal(1, state.submitted)
    end)

    it("reports synchronous session acquisition failures", function()
        local notification
        package.loaded["agentic.session_registry"] = {
            get_session_for_tab_page = function()
                error("registry unavailable")
            end,
        }
        vim.notify = function(message, level)
            notification = { message = message, level = level }
        end

        assert.is_false(review_ui.send_agent_command("/neovim-review self abc123"))
        assert.is_truthy(notification.message:find("registry unavailable", 1, true))
        assert.are.equal(vim.log.levels.ERROR, notification.level)
    end)

    it("waits for agent session initialization before submitting", function()
        local session, state = make_session(nil)
        local deferred
        package.loaded["agentic.session_registry"] = {
            get_session_for_tab_page = function(_, callback)
                callback(session)
            end,
        }
        vim.defer_fn = function(callback)
            deferred = callback
        end

        assert.is_true(review_ui.send_agent_command("/neovim-review self abc123"))
        assert.are.equal(0, state.submitted)
        session.session_id = "session-1"
        deferred()
        assert.are.equal(1, state.submitted)
    end)

    it("reports session initialization timeout", function()
        local session = make_session(nil)
        local deferred = {}
        local notification
        package.loaded["agentic.session_registry"] = {
            get_session_for_tab_page = function(_, callback)
                callback(session)
            end,
        }
        vim.defer_fn = function(callback)
            deferred[#deferred + 1] = callback
        end
        vim.notify = function(message, level)
            notification = { message = message, level = level }
        end

        assert.is_true(review_ui.send_agent_command("/neovim-review self abc123"))
        while deferred[1] do
            table.remove(deferred, 1)()
        end
        assert.is_truthy(notification.message:find("timed out", 1, true))
        assert.are.equal(vim.log.levels.ERROR, notification.level)
    end)

    it("reports command submission failures", function()
        local session = make_session("session-1", "submit failed")
        local notification
        package.loaded["agentic.session_registry"] = {
            get_session_for_tab_page = function(_, callback)
                callback(session)
            end,
        }
        vim.notify = function(message, level)
            notification = { message = message, level = level }
        end

        assert.is_true(review_ui.send_agent_command("/neovim-review self abc123"))
        assert.is_truthy(notification.message:find("submit failed", 1, true))
        assert.are.equal(vim.log.levels.ERROR, notification.level)
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

    it("submits the resolved merge-base after bare Review starts", function()
        local events = {}
        local seen = {}
        stub_success(events, seen)

        vim.cmd("Review")

        assert.is_nil(seen.requested_base)
        assert.are.equal("/neovim-review self resolved-merge-base", seen.command)
        assert.are.same({ "help", "picker", "agent" }, events)
    end)

    it("preserves explicit base selection while submitting the resolved merge-base", function()
        local events = {}
        local seen = {}
        stub_success(events, seen)

        vim.cmd("Review HEAD~2")

        assert.are.equal("HEAD~2", seen.requested_base)
        assert.are.equal("/neovim-review self resolved-merge-base", seen.command)
        assert.are.same({ "help", "picker", "agent" }, events)
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