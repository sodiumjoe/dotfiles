package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
require("snacks").setup({ picker = { enabled = true } })
local sessions = require("sodium.agentic_sessions")

describe("Saved conversation picker", function()
    local columns, lines, provider, notify, select_ui, notifications

    before_each(function()
        columns, lines = vim.o.columns, vim.o.lines
        vim.o.columns, vim.o.lines = 180, 50
        local config = require("agentic.config")
        provider = config.acp_providers.agency
        config.acp_providers.agency = { name = "Agency", command = "fixture", args = {} }
        notify, select_ui, notifications = vim.notify, vim.ui.select, {}
        vim.notify = function(message) notifications[#notifications + 1] = message end
    end)
    after_each(function()
        for _, picker in ipairs(Snacks.picker.get()) do picker:close() end
        vim.wait(50, function() return false end)
        vim.o.columns, vim.o.lines = columns, lines
        vim.wait(30, function() return false end)
        require("agentic.config").acp_providers.agency = provider
        vim.notify, vim.ui.select = notify, select_ui
    end)

    local function stopped(id, extra)
        return vim.tbl_deep_extend("force", { live = false, cleanup = "verified", unavailable = vim.NIL, record = { version = 3, phase = "stopped",
            definition = { agentId = id, backendId = "codex-acp", cwd = "/tmp/project" }, settings = { configValues = { model = "gpt-5" } }, launch = vim.NIL } }, extra or {})
    end

    local function open(options)
        options = options or {}
        local state = { pages = {}, excerpts = {} }
        local lifecycle = {
            page = function(page_options, callback) state.pages[#state.pages + 1] = { options = page_options, callback = callback } end,
            excerpt = function(excerpt, callback) state.excerpts[#state.excerpts + 1] = { excerpt = excerpt, callback = callback } end,
            restore = options.restore or function() end,
            attach = function() error("Unexpected attach") end,
        }
        local agent = { provider_config = require("agentic.config").acp_providers.agency }
        function agent:when_ready() error("The Agency restore picker must not wait for the ACP client") end
        sessions.show_picker({ agent = agent }, { lifecycle = lifecycle })
        local picker
        assert.is_true(vim.wait(1000, function()
            for _, candidate in ipairs(Snacks.picker.get()) do
                if candidate.opts.title == "Select session to restore" then picker = candidate; return true end
            end
        end))
        return picker, state
    end

    local function answer(state, agents)
        assert.is_true(vim.wait(1000, function() return #state.pages == 1 end))
        state.pages[1].callback(nil, { agents = agents, issues = {}, handlerGeneration = "h" })
    end

    it("opens before sessions load, then lists only stopped and recoverable sessions by recent activity", function()
        local picker, state = open()
        assert.are.equal("Select session to restore (loading…)", picker.title)
        assert.is_true(state.pages[1].options.allow_issues)
        local live = stopped("live", { live = true, record = { phase = "ready" } })
        answer(state, { stopped("older", { record = { lastActivityAt = "2026-11-12T00:00:00Z", title = "older chat" } }), live,
            stopped("newer", { record = { phase = "recoverable", lastActivityAt = "2026-11-13T00:00:00Z", title = "newer chat" } }), stopped("untimed") })
        assert.is_true(vim.wait(1000, function() return picker.list:count() == 3 and not picker:is_active() end))
        assert.are.equal("Select session to restore", picker.title)
        assert.are.same({ "newer", "older", "untimed" }, { picker.list:get(1).id, picker.list:get(2).id, picker.list:get(3).id })
        assert.are.equal("Needs recovery", picker.list:get(1).status)
        assert.are.equal("Codex · gpt-5", picker.list:get(2).model)
    end)

    it("previews the saved conversation", function()
        local picker, state = open()
        answer(state, { stopped("one", { record = { title = "Review the restore picker", lastActivityAt = "2026-11-13T00:00:00Z" } }) })
        assert.is_true(vim.wait(1000, function() return #state.excerpts == 1 end))
        assert.are.equal("one", state.excerpts[1].excerpt.agentId)
        state.excerpts[1].callback(nil, { state = "excerpt", source = "history", turns = { { role = "user", text = "fix the picker" } }, reason = vim.NIL })
        assert.is_true(vim.wait(1000, function()
            local preview = table.concat(vim.api.nvim_buf_get_lines(picker.preview.win.buf, 0, -1, false), "\n")
            return preview:find("Review the restore picker", 1, true) ~= nil and preview:find("/tmp/project", 1, true) ~= nil
                and preview:find("› you: fix the picker", 1, true) ~= nil
        end))
    end)

    it("restores the selected logical ID after confirmation without attaching", function()
        local restored
        vim.ui.select = function(_, _, callback) callback("Restore") end
        local picker, state = open({ restore = function(id) restored = id end })
        answer(state, { stopped("closed", { record = { phase = "recoverable" } }) })
        assert.is_true(vim.wait(1000, function() return picker.list:count() == 1 end))
        picker.opts.confirm(picker, picker:current())
        assert.is_true(vim.wait(1000, function() return restored ~= nil end))
        assert.are.equal("closed", restored)
    end)

    it("ignores the listing after the picker closes", function()
        local picker, state = open()
        picker:close()
        local title, count = picker.title, picker.list:count()
        answer(state, { stopped("late") })
        vim.wait(50, function() return false end)
        assert.is_true(picker.closed)
        assert.are.equal(title, picker.title)
        assert.are.equal(count, picker.list:count())
    end)

    local function search(picker, query)
        picker.input:set(query)
        picker:find({ refresh = false })
        assert.is_true(vim.wait(1000, function() return not picker:is_active() and picker.list:count() == 1 end))
        assert.is_not_nil(picker.list:get(1).issue)
    end

    it("keeps a listing error searchable", function()
        local picker, state = open()
        assert.is_true(vim.wait(1000, function() return #state.pages == 1 end))
        state.pages[1].callback({ code = "UNAVAILABLE", message = "Handler down" })
        assert.is_true(vim.wait(1000, function() return picker.list:count() == 1 and not picker:is_active() end))
        search(picker, "handler down")
    end)

    it("keeps listing issues searchable beside sessions", function()
        local picker, state = open()
        assert.is_true(vim.wait(1000, function() return #state.pages == 1 end))
        state.pages[1].callback(nil, { agents = { stopped("one") }, issues = { { code = "CORRUPT", message = "Unreadable record" } }, handlerGeneration = "h" })
        assert.is_true(vim.wait(1000, function() return picker.list:count() == 2 and not picker:is_active() end))
        search(picker, "unreadable")
    end)

    it("gives untitled sessions distinguishable searchable rows", function()
        local items = sessions.normalize_sessions({
            { nativeSessionId = "first-id", cwd = "/tmp/first", backendId = "codex-acp" },
            { nativeSessionId = "second-id", cwd = "/tmp/second", backendId = "codex-acp" },
        })
        assert.is_not.equal(items[1].text, items[2].text)
        assert.is_truthy(items[1].text:find("first", 1, true))
        assert.is_truthy(items[2].text:find("second", 1, true))
    end)
    it("starts an absent Handler without cancelling a pending attach", function()
        local control = require("fixtures.agency_control")
        local transport = control.operations()
        local attached
        transport.operations.attach(control.target_a, function(err, manager) attached = { err = err, manager = manager } end)
        assert.are.same({ "agent", "page" }, vim.list_slice(transport.calls[1].argv, 1, 2))
        local agent = { provider_config = require("agentic.config").acp_providers.agency }
        local picker = sessions.show_picker({ agent = agent }, { lifecycle = { page = transport.operations.page, excerpt = function() end } })
        assert.are.same({ "agent", "page" }, vim.list_slice(transport.calls[2].argv, 1, 2))
        transport.respond(2, nil, { code = "UNAVAILABLE", message = "Handler down" })
        assert.are.same({ "status" }, transport.calls[3].argv)
        transport.respond(3, { phase = "ready" })
        transport.respond(4, control.page({ control.agent(control.target_b, "stopped") }))
        assert.is_true(vim.wait(1000, function() return picker.list:count() == 1 and not picker:is_active() end))
        transport.respond(1, control.page({ control.agent(control.target_a) }))
        assert.is_nil(attached.err)
        assert.are.equal(1, #transport.opened)
    end)
end)