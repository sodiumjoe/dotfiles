package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
local fixture = require("fixtures.agency")

describe("Agency roster picker", function()
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
    local function open()
        return require("sodium.agency.picker").open({
            timer_factory = function()
                return timer
            end,
            page = function(opts, callback)
                assert.is_true(opts.allow_issues)
                requests[#requests + 1] = callback
            end,
            attach = function(id)
                calls[#calls + 1] = { "attach", id }
            end,
            restore = function(id)
                calls[#calls + 1] = { "restore", id }
            end,
            stop = function(row)
                calls[#calls + 1] = { "stop", row }
            end,
            new = function() end,
            snapshot = function() end,
            notify = function() end,
        })
    end
    it("does not overlap polls and discards callbacks after close", function()
        open()
        timer.tick()
        vim.wait(20)
        assert.are.equal(1, #requests)
        picker.close()
        requests[1](nil, { agents = { fixture.agent(fixture.target_a) }, issues = {} })
        assert.are.equal(0, #picker.opts.items)
        assert.is_true(timer.stopped)
        assert.is_true(timer.closed)
    end)
    it("renders issues and transitional records without attaching", function()
        open()
        requests[1](
            nil,
            {
                agents = { fixture.agent(fixture.target_a, "starting") },
                issues = {
                    { path = "/state/broken", message = "broken" },
                },
            }
        )
        assert.are.equal(2, #picker.opts.items)
        options.confirm(picker, picker.opts.items[1])
        assert.are.equal(0, #calls)
        assert.is_truthy(picker.opts.items[2].text:find("broken", 1, true))
    end)
    it("attaches ready rows and restores only explicitly with verified cleanup", function()
        open()
        local row = fixture.agent(fixture.target_a)
        requests[1](nil, { agents = { row }, issues = {} })
        options.confirm(picker, picker.opts.items[1])
        assert.are.same({ "attach", fixture.target_a.agentId }, calls[1])
        row.record.phase, row.cleanup = "recoverable", "unverified"
        open()
        requests[2](nil, { agents = { row }, issues = {} })
        options.actions.restore(picker)
        assert.are.equal(1, #calls)
        picker.opts.items[1].view.cleanup = "verified"
        options.actions.restore(picker)
        assert.are.same({ "restore", fixture.target_a.agentId }, calls[2])
    end)
    it("stops the selected immutable row", function()
        open()
        requests[1](nil, { agents = { fixture.agent(fixture.target_b) }, issues = {} })
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