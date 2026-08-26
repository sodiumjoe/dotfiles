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