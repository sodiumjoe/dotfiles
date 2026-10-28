package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
local fixture = require("fixtures.agency_control")

describe("Agency current-directory conversation picker", function()
    local original, select_ui, options, picker, f, results
    before_each(function()
        original, select_ui, results = _G.Snacks, vim.ui.select, {}
        vim.ui.select = function(_, _, callback) callback(nil) end
        picker = { close = function() options.on_close() end }
        _G.Snacks = { picker = function(opts)
            options, picker.opts = opts, opts
            return picker
        end }
        f = fixture.operations()
    end)
    after_each(function()
        if options and options.on_close then
            options.on_close()
            vim.wait(1000, function() return #results > 0 end)
        end
        _G.Snacks, vim.ui.select = original, select_ui
        options = nil
    end)
    local function open()
        f.operations.current("/work/a", function(err, manager)
            results[#results + 1] = { error = err, manager = manager }
        end)
        local first, second = fixture.agent(fixture.target_a), fixture.agent(fixture.target_b)
        first.display = { title = "Fix picker previews<environment_info> - Current branch: moon/picker - Shell: /bin/zsh </environment_info>", activity = "working" }
        second.display = { title = "Review session cleanup", activity = "idle" }
        second.record.definition.backendId = "claude-agent-acp"
        second.record.settings.modelId = "model-b"
        f.respond(1, fixture.page({ first, second }))
        return first, second
    end
    it("shows conversation titles, models and activity with a visible metadata preview", function()
        open()
        assert.are.equal("Agency conversations", options.title)
        assert.are.equal(2, #options.items)
        assert.are.equal("Fix picker previews · Codex/model-a · /work/a · Working · Available to open", options.items[1].text)
        assert.are.equal("Review session cleanup · Claude/model-b · /work/a · Waiting for input · Available to open", options.items[2].text)
        assert.is_function(options.preview)
        assert.is_false(vim.tbl_contains((options.layout or {}).hidden or {}, "preview"))
        local lines
        options.preview({ item = options.items[1], preview = {
            reset = function() end,
            set_lines = function(_, value) lines = value end,
        } })
        local text = table.concat(lines, "\n")
        assert.is_truthy(text:find("Agent ID:     " .. fixture.target_a.agentId, 1, true))
        assert.is_truthy(text:find("Branch:       moon/picker", 1, true))
        assert.is_truthy(text:find("Shell:        /bin/zsh", 1, true))
        assert.are.equal(0, #f.opened)
        assert.are.equal(0, #results)
    end)
    it("opens the selected immutable conversation after picker teardown", function()
        local _, second = open()
        second.record.launch.providerGeneration = fixture.id(99)
        local win = vim.api.nvim_open_win(vim.api.nvim_create_buf(false, true), false,
            { relative = "editor", row = 1, col = 1, width = 20, height = 3, style = "minimal" })
        picker.layout = { get_wins = function() return { { win = win } } end }
        picker.close = function()
            options.on_close()
            vim.defer_fn(function() vim.api.nvim_win_close(win, true) end, 20)
        end
        options.confirm(picker, options.items[2])
        assert.are.equal(0, #f.opened)
        assert.is_true(vim.wait(1000, function() return #results > 0 end))
        assert.is_false(vim.api.nvim_win_is_valid(win))
        assert.are.equal(1, #f.opened)
        assert.are.same(fixture.target_b, f.opened[1].record.launch)
        assert.are.equal("agency:" .. fixture.target_b.agentId, results[1].manager.session_id)
        assert.is_nil(results[1].error)
        assert.are.equal(1, #f.calls)
    end)
    it("cancels once without creating, opening or stopping a conversation", function()
        open()
        options.on_close()
        options.on_close()
        assert.is_true(vim.wait(1000, function() return #results > 0 end))
        assert.are.equal(1, #results)
        assert.are.equal("CANCELLED", results[1].error.code)
        assert.are.equal(0, #f.opened)
        assert.are.equal(1, #f.calls)
    end)
    it("rejects a selection superseded while the chooser was open", function()
        open()
        f.operations.detach()
        options.confirm(picker, options.items[1])
        assert.is_true(vim.wait(1000, function() return #results > 0 end))
        assert.are.equal("CANCELLED", results[1].error.code)
        assert.are.equal(0, #f.opened)
        assert.are.equal(1, #f.calls)
    end)
    it("renders the conversation list and metadata preview through the actual Snacks layout", function()
        _G.Snacks = require("snacks")
        if not Snacks.did_setup then
            Snacks.setup({ picker = require("sodium.plugins.pickers").opts.picker, notifier = { enabled = false } })
        end
        local columns, lines = vim.o.columns, vim.o.lines
        vim.o.columns, vim.o.lines = 220, 60
        local row = fixture.agent(fixture.target_a)
        row.display = { title = "Fix picker previews", activity = "working" }
        local real = require("sodium.agency.picker").current({ row, fixture.agent(fixture.target_b) }, function(view)
            results[#results + 1] = { manager = view }
        end)
        local ok, err = pcall(function()
            assert.is_true(vim.wait(1000, function()
                return real.list.win:valid() and real.preview.win:valid() and real:current() ~= nil
            end))
            real:show_preview()
            assert.is_true(vim.wait(1000, function()
                local preview = table.concat(vim.api.nvim_buf_get_lines(real.preview.win.buf, 0, -1, false), "\n")
                return preview:find("Agent ID:     " .. fixture.target_a.agentId, 1, true) ~= nil
            end))
            local text = table.concat(vim.api.nvim_buf_get_lines(real.list.win.buf, 0, -1, false), "\n")
            assert.is_truthy(text:find("Fix picker previews", 1, true))
            assert.is_truthy(text:find("Codex/model-a", 1, true))
            assert.is_truthy(text:find("Working", 1, true))
        end)
        real:close()
        vim.wait(1000, function() return #results > 0 end)
        vim.o.columns, vim.o.lines = columns, lines
        assert.is_true(ok, err)
    end)
    it("retains single-match direct attachment without opening a chooser", function()
        f.operations.current("/work/a", function(err, manager)
            assert.is_nil(err)
            results[#results + 1] = manager
        end)
        f.respond(1, fixture.page({ fixture.agent(fixture.target_a) }))
        assert.is_nil(options)
        assert.are.equal(1, #f.opened)
        assert.are.equal(1, #results)
    end)
end)