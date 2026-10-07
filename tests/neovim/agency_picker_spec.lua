package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
local fixture = require("fixtures.agency_control")

local function check_text_preview(options, item)
    assert.is_truthy(vim.tbl_contains((options.layout or {}).hidden or {}, "preview"))
    assert.are.equal("function", type(options.preview))
    local buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, { "stale preview" })
    local ok, err = pcall(options.preview, {
        item = item,
        buf = buf,
        preview = {
            reset = function()
                vim.api.nvim_buf_set_lines(buf, 0, -1, false, {})
            end,
        },
    })
    local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
    vim.api.nvim_buf_delete(buf, { force = true })
    assert.is_true(ok, err)
    assert.are.same({ "" }, lines)
end

describe("Agency active picker", function()
    local original, requests, timer, picker, options, calls
    before_each(function()
        original = _G.Snacks
        requests, calls = {}, {}
        timer = {
            start = function(_, delay, interval, callback)
                assert.are.equal(5000, delay)
                assert.are.equal(5000, interval)
                timer.tick = callback
            end,
            stop = function()
                timer.stopped = true
            end,
            close = function()
                timer.closed = true
            end,
        }
        picker = {
            find = function() end,
            current = function()
                return picker.opts.items[1]
            end,
            close = function()
                options.on_close()
            end,
        }
        _G.Snacks = {
            picker = function(opts)
                options, picker.opts = opts, opts
                return picker
            end,
        }
    end)
    after_each(function()
        if options then
            options.on_close()
        end
        _G.Snacks = original
    end)
    local function open(snapshot)
        return require("sodium.agency.picker").open({
            timer_factory = function()
                return timer
            end,
            page = function(opts, callback)
                assert.is_true(opts.allow_issues)
                requests[#requests + 1] = callback
            end,
            attach = function(id, _, row)
                calls[#calls + 1] = { "attach", id, row }
            end,
            restore = function(id)
                calls[#calls + 1] = { "restore", id }
            end,
            stop = function(row)
                calls[#calls + 1] = { "stop", row }
            end,
            new = function() calls[#calls + 1] = { "new" } end,
            snapshot = function() return snapshot end,
            notify = function() end,
        })
    end
    local function respond(index, agents, issues)
        requests[index](nil, { agents = agents, issues = issues or {}, handlerGeneration = fixture.target_a.handlerGeneration })
    end
    it("shows only live current-generation agents across directories", function()
        open()
        local current = fixture.agent(fixture.target_a)
        local other = fixture.agent(fixture.target_b)
        other.record.definition.cwd = "/work/b"
        other.record.settings = { configValues = { model = "model-b" } }
        local stopped = fixture.agent(fixture.target_a, "stopped")
        local old = fixture.agent(fixture.target_a)
        old.record.launch.handlerGeneration = fixture.id(99)
        local missing = fixture.agent(fixture.target_a)
        missing.record.launch = vim.NIL
        respond(1, { current, other, stopped, old, missing, { record = { version = 1, phase = "stopped", spec = { agentId = fixture.id(98),
            checkout = { root = { path = "/work/legacy" } } } }, live = false, cleanup = "unknown" } })
        assert.are.equal("Agency active agents", options.title)
        assert.are.equal(2, #picker.opts.items)
        assert.is_truthy(picker.opts.items[2].text:find("/work/b", 1, true))
        assert.is_truthy(picker.opts.items[2].text:find("codex-acp/model-b", 1, true))
        assert.is_nil(options.actions.restore)
        assert.is_nil(options.actions.new)
    end)
    it("keeps an attached agent with an ongoing turn selectable", function()
        open({ target = vim.deepcopy(fixture.target_a), connected = true, busy = true })
        respond(1, { fixture.agent(fixture.target_a) })
        assert.are.equal(1, #picker.opts.items)
        assert.is_truthy(picker.opts.items[1].text:find("attached", 1, true))
        options.confirm(picker, picker.opts.items[1])
        assert.are.same({ "attach", fixture.target_a.agentId, fixture.agent(fixture.target_a) }, calls[1])
    end)
    it("leaves an empty active picker empty without creating or restoring", function()
        open()
        respond(1, { fixture.agent(fixture.target_a, "stopped") })
        options.confirm(picker, nil)
        assert.are.equal(0, #picker.opts.items)
        assert.are.equal(0, #calls)
    end)
    it("removes exited agents on refresh without selecting a replacement", function()
        open()
        respond(1, { fixture.agent(fixture.target_a) })
        options.actions.refresh()
        respond(2, { fixture.agent(fixture.target_a, "stopped") })
        assert.are.equal(0, #picker.opts.items)
        assert.are.equal(0, #calls)
    end)
    it("keeps the empty roster open until its first asynchronous poll completes", function()
        open()
        assert.are.equal(0, #options.items)
        assert.is_true(options.show_empty)
        assert.are.equal(1, #requests)
        respond(1, { fixture.agent(fixture.target_a) })
        assert.are.equal(1, #options.items)
    end)
    it("keeps fileless roster rows safe when preview is toggled", function()
        open()
        respond(1, { fixture.agent(fixture.target_a) })
        assert.is_nil(picker.opts.items[1].file)
        check_text_preview(options, picker.opts.items[1])
    end)
    it("keeps fileless launch choices safe when preview is toggled", function()
        require("sodium.agency.picker").choices(
            {},
            { { displayName = "Model A", selection = fixture.selection } },
            {},
            function() end,
            {}
        )
        assert.is_nil(picker.opts.items[1].file)
        check_text_preview(options, picker.opts.items[1])
    end)
    it("does not overlap polls and discards callbacks after close", function()
        open()
        timer.tick()
        vim.wait(20)
        assert.are.equal(1, #requests)
        picker.close()
        respond(1, { fixture.agent(fixture.target_a) })
        assert.are.equal(0, #picker.opts.items)
        assert.is_true(timer.stopped)
        assert.is_true(timer.closed)
    end)
    it("renders live transitional records and issues without attaching", function()
        open()
        local rows = {}
        for _, phase in ipairs({ "starting", "restoring", "stopping" }) do
            local row = fixture.agent(fixture.target_a, phase)
            row.live = true
            rows[#rows + 1] = row
        end
        respond(1, rows, { { path = "/state/broken", message = "broken" } })
        assert.are.equal(4, #picker.opts.items)
        for _, item in ipairs(picker.opts.items) do options.confirm(picker, item) end
        assert.are.equal(0, #calls)
        assert.is_truthy(picker.opts.items[4].text:find("broken", 1, true))
    end)
    it("attaches the exact immutable ready row without creating or restoring", function()
        open()
        local row = fixture.agent(fixture.target_a)
        respond(1, { row })
        row.record.launch.providerGeneration = fixture.id(99)
        options.confirm(picker, picker.opts.items[1])
        assert.are.same({ "attach", fixture.target_a.agentId, fixture.agent(fixture.target_a) }, calls[1])
        assert.are.equal(1, #calls)
    end)
    it("stops the selected immutable row", function()
        open()
        respond(1, { fixture.agent(fixture.target_b) })
        options.actions.stop(picker)
        assert.are.equal(fixture.target_b.agentId, calls[1][2].record.definition.agentId)
    end)
    it("refreshes explicitly with one retained identity and rereads exact choices", function()
        local command_calls, selected = {}, nil
        local client = {
            command = function(argv, opts, callback)
                command_calls[#command_calls + 1] = { argv = argv, opts = opts, callback = callback }
            end,
        }
        local initial = {}
        require("sodium.agency.picker").choices(
            client,
            initial,
            {
                cwd = "/work/a",
                handlerGeneration = fixture.target_a.handlerGeneration,
                unavailable = { { providerId = "codex-acp", reason = "stale" } },
            },
            function(choice)
                selected = choice
            end,
            {
                uuid = function()
                    return fixture.id(600)
                end,
                notify = function() end,
            }
        )
        assert.are.equal(0, #command_calls)
        options.actions.refresh()
        options.actions.refresh()
        assert.are.equal(1, #command_calls)
        assert.are.same(
            {
                "model",
                "refresh",
                "--command-id",
                fixture.id(600),
                "--handler-generation",
                fixture.target_a.handlerGeneration,
            },
            command_calls[1].argv
        )
        command_calls[1].callback({ code = "UNAVAILABLE" })
        options.actions.refresh()
        assert.are.same(command_calls[1].argv, command_calls[2].argv)
        command_calls[2].callback(
            nil,
            { handlerGeneration = fixture.target_a.handlerGeneration, result = fixture.refresh() }
        )
        assert.are.same({ "agent", "choices" }, command_calls[3].argv)
        options.actions.refresh()
        assert.are.equal(3, #command_calls)
        local choice = {
            displayName = "Model A",
            selection = fixture.selection,
            snapshotId = fixture.id(601),
            contractFingerprint = string.rep("a", 64),
        }
        command_calls[3].callback(
            nil,
            {
                handlerGeneration = fixture.target_a.handlerGeneration,
                result = { choices = { choice }, unavailable = {} },
            }
        )
        options.confirm(picker, picker.opts.items[1])
        assert.are.same(choice, selected)
        assert.are.same({ choice }, initial)
    end)
end)