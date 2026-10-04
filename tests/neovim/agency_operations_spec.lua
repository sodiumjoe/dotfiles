package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
local fixture = require("fixtures.agency")

describe("Agency lifecycle operations", function()
    it("ensures an absent Handler once before retrying current inventory under captured cwd", function()
        local f = fixture.operations()
        local error
        local origin = { tab = vim.api.nvim_get_current_tabpage(), buffer = vim.api.nvim_get_current_buf(), cwd = "/work/a" }
        f.operations.current(origin.cwd, function(err) error = err end, origin)
        f.respond(1, nil, { code = "UNAVAILABLE" })
        assert.are.equal(2, #f.calls)
        assert.are.same({ "status" }, f.calls[2].argv)
        assert.are.equal("/work/a", f.calls[2].options.cwd)
        local old = vim.fn.getcwd()
        vim.cmd.lcd("/tmp")
        f.respond(2, { phase = "ready" })
        f.respond(3, fixture.page({ fixture.agent(fixture.target_a) }))
        vim.cmd.lcd(old)
        f.snapshot(1)
        assert.is_nil(error)
        assert.are.same(origin, f.operations.attachment().origin)
        assert.are.equal("/work/a", f.calls[3].options.cwd)
        f.operations.detach()
    end)
    it("does not treat a second unavailable inventory as zero agents", function()
        local f = fixture.operations()
        local error
        f.operations.current("/work/a", function(err) error = err end)
        f.respond(1, nil, { code = "UNAVAILABLE" })
        assert.are.equal(2, #f.calls)
        f.respond(2, { phase = "ready" })
        f.respond(3, nil, { code = "UNAVAILABLE" })
        assert.are.equal("UNAVAILABLE", error and error.code)
        assert.are.equal(3, #f.calls)
        assert.are.equal(0, #f.selections)
        assert.are.equal(0, #f.streams)
    end)
    it("surfaces Handler ensure failure without a launch or retry", function()
        local f = fixture.operations()
        local error
        f.operations.current("/work/a", function(err) error = err end)
        f.respond(1, nil, { code = "UNAVAILABLE" })
        assert.are.equal(2, #f.calls)
        f.respond(2, nil, { code = "INCOMPLETE" })
        assert.are.equal("INCOMPLETE", error and error.code)
        assert.are.equal(2, #f.calls)
    end)
    it("does not retry cold inventory after a newer operation supersedes its ensure", function()
        local f = fixture.operations()
        local error
        f.operations.current("/work/a", function(err) error = err end)
        f.respond(1, nil, { code = "UNAVAILABLE" })
        assert.are.equal(2, #f.calls)
        f.operations.attach(fixture.target_b, function() end)
        f.respond(2, { phase = "ready" })
        assert.are.equal("CANCELLED", error and error.code)
        assert.are.equal(2, #f.calls)
        f.operations.detach()
    end)
    it("rejects inventory from a Handler replacing the ensured generation", function()
        local f = fixture.operations()
        local error
        f.operations.current("/work/a", function(err) error = err end)
        f.respond(1, nil, { code = "UNAVAILABLE" })
        assert.are.equal(2, #f.calls)
        f.respond(2, { phase = "ready" })
        f.respond(3, fixture.page({ fixture.agent(fixture.target_b) }), nil, fixture.target_b.handlerGeneration)
        assert.are.equal("STALE_HANDLER", error and error.code)
        assert.are.equal(0, #f.streams)
    end)
    it("launches through authoritative choices after cold inventory proves no active agents", function()
        local f = fixture.operations()
        f.operations.current("/work/a", function() end)
        f.respond(1, nil, { code = "UNAVAILABLE" })
        f.respond(2, { phase = "ready" })
        f.respond(3, fixture.page())
        assert.are.same({ "status" }, f.calls[4].argv)
        f.respond(4, { phase = "ready" })
        assert.are.same({ "agent", "choices" }, f.calls[5].argv)
        assert.are.equal(0, #f.streams)
        f.respond(5, { state = "choices", choices = { { selection = fixture.selection } }, unavailable = {} })
        f.selections[1].callback(nil)
    end)
    it("settles staging after the captured tab closes without changing the attachment", function()
        local f = fixture.operations()
        local error
        vim.cmd.tabnew()
        f.operations.attach(fixture.target_a, function(err) error = err end)
        vim.cmd.tabclose()
        f.snapshot(1)
        assert.are.equal("CANCELLED", error and error.code)
        assert.is_nil(f.operations.attachment())
        assert.is_true(f.streams[1].closed)
    end)
    it("retains explicit origin through a delayed restore", function()
        local f = fixture.operations()
        local tab, buffer = vim.api.nvim_get_current_tabpage(), vim.api.nvim_get_current_buf()
        local origin = { tab = tab, buffer = buffer, cwd = "/work/origin" }
        f.operations.restore(fixture.target_a.agentId, function() end, origin)
        vim.cmd.tabnew()
        f.respond(1, { phase = "ready" })
        f.respond(2, fixture.command(fixture.target_a, "restored"))
        f.snapshot(1)
        assert.are.same(origin, f.operations.attachment().origin)
        assert.are.equal("/work/origin", f.calls[2].options.cwd)
        vim.cmd.tabclose()
    end)
    it("returns roster issues through issue-only continuation pages", function()
        local f = fixture.operations()
        local result
        f.operations.page({ allow_issues = true }, function(err, value)
            assert.is_nil(err)
            result = value
        end)
        local page = fixture.page({}, "issues-next")
        page.issues = { { kind = "agent", path = "/broken/a", message = "broken", id = vim.NIL } }
        f.respond(1, page)
        f.respond(2, fixture.page({ fixture.agent(fixture.target_a) }))
        assert.are.equal(1, #result.issues)
        assert.are.equal(1, #result.agents)
    end)
    it("completes a superseded snapshot callback without stopping either agent", function()
        local f = fixture.operations()
        local error
        f.operations.attach(fixture.target_a, function(value)
            error = value
        end)
        f.operations.attach(fixture.target_b, function() end)
        assert.are.equal("CANCELLED", error.code)
        assert.is_true(f.streams[1].closed)
        assert.are.equal(0, #f.calls)
        f.snapshot(2)
        assert.are.same(fixture.target_b, f.operations.attachment().target)
    end)

    it("retains and reports a successful superseded start without attaching or stopping it", function()
        local f = fixture.operations()
        local first_error
        f.operations.new("/work/a", function(error)
            first_error = error
        end)
        f.respond(1, { phase = "ready" })
        f.respond(2, { state = "choices", choices = { { selection = fixture.selection } }, unavailable = {} })
        f.selections[1].callback(f.selections[1].choices[1])
        f.operations.current("/work/a", function() end)
        f.respond(3, fixture.command(fixture.target_a, "started"))
        assert.are.equal("CANCELLED", first_error.code)
        assert.are.same(fixture.target_a, f.reports[1].target)
        assert.are.equal(0, #f.streams)
        assert.are.equal(4, #f.calls)
    end)

    it("does not dispatch a choice after a newer operation or picker cancellation", function()
        local f = fixture.operations()
        local errors = {}
        f.operations.new("/work/a", function(error)
            errors[#errors + 1] = error
        end)
        f.respond(1, { phase = "ready" })
        f.respond(2, { state = "choices", choices = { { selection = fixture.selection } }, unavailable = {} })
        f.operations.current("/work/a", function() end)
        f.selections[1].callback(f.selections[1].choices[1])
        assert.are.equal("CANCELLED", errors[1].code)
        assert.are.equal(3, #f.calls)
        local cancelled = fixture.operations()
        cancelled.operations.new("/work/a", function(error)
            errors[#errors + 1] = error
        end)
        cancelled.respond(1, { phase = "ready" })
        cancelled.respond(2, { state = "choices", choices = { { selection = fixture.selection } }, unavailable = {} })
        cancelled.selections[1].callback(nil)
        assert.are.equal("CANCELLED", errors[2].code)
        assert.are.equal(2, #cancelled.calls)
    end)

    it("retries only explicit inventory resynchronization and only once", function()
        local f = fixture.operations()
        local error
        f.operations.current("/work/a", function(value)
            error = value
        end)
        f.respond(1, fixture.page({}, "cursor-one"))
        f.respond(2, nil, { code = "RESYNC_REQUIRED" })
        f.respond(3, fixture.page({}, "cursor-two", fixture.id(501)))
        f.respond(4, nil, { code = "RESYNC_REQUIRED" })
        assert.are.equal("RESYNC_REQUIRED", error.code)
        assert.are.equal(4, #f.calls)
        assert.is_false(vim.tbl_contains(f.calls[3].argv, "--cursor"))
    end)

    it("does not launch after inventory issues or an error on a later page", function()
        for _, kind in ipairs({ "issue", "error" }) do
            local f = fixture.operations()
            local error
            f.operations.current("/work/a", function(value)
                error = value
            end)
            if kind == "issue" then
                local page = fixture.page()
                page.issues = { { kind = "agent", id = vim.NIL, path = "/state/broken", message = "broken" } }
                f.respond(1, page)
                assert.are.equal("INCOMPLETE", error.code)
                assert.are.equal(1, #f.calls)
            else
                f.respond(1, fixture.page({}, "cursor"))
                f.respond(2, nil, { code = "UNAVAILABLE" })
                assert.are.equal("UNAVAILABLE", error.code)
                assert.are.equal(2, #f.calls)
            end
            assert.are.equal(0, #f.streams)
        end
    end)

    it("selects the captured row among several agents after cwd changes", function()
        local f = fixture.operations()
        local other = vim.deepcopy(fixture.target_a)
        other.agentId = fixture.id(4)
        other.providerGeneration = fixture.id(5)
        local old_cwd = vim.fn.getcwd()
        f.operations.current("/work/a", function() end)
        f.respond(1, fixture.page({ fixture.agent(fixture.target_a), fixture.agent(other) }))
        vim.cmd.lcd("/tmp")
        f.selections[1].callback(f.selections[1].agents[2])
        assert.are.same(other, f.streams[1].target)
        assert.are.equal("/work/a", f.calls[1].options.cwd)
        vim.cmd.lcd(old_cwd)
    end)

    it("preserves the old view on stale-generation reconnect or rejected restoration", function()
        local f = fixture.operations()
        local error
        f.operations.attach(fixture.target_a, function() end)
        f.snapshot(1)
        f.operations.attach(fixture.target_b, function(value)
            error = value
        end)
        f.streams[2].handlers.on_fault({ code = "STALE_PROVIDER" })
        assert.are.equal("STALE_PROVIDER", error.code)
        assert.is_false(f.streams[1].closed)
        assert.are.same(fixture.target_a, f.operations.attachment().target)
        f.operations.restore(fixture.target_b.agentId, function(value)
            error = value
        end)
        f.respond(1, { phase = "ready" })
        f.respond(2, nil, { code = "SESSION_UNAVAILABLE" })
        assert.are.equal("SESSION_UNAVAILABLE", error.code)
        assert.are.equal(2, #f.calls)
        assert.are.equal(2, #f.streams)
    end)

    it("retains a pending command for inspection and attaches only after verified completion", function()
        local f = fixture.operations()
        local error
        f.operations.restore(fixture.target_a.agentId, function(value)
            error = value
        end)
        f.respond(1, { phase = "ready" })
        f.respond(2, fixture.command(fixture.target_a, "pending"))
        assert.are.equal("INCOMPLETE", error.code)
        assert.are.equal(0, #f.streams)
        f.operations.inspect_pending(function() end)
        f.respond(3, fixture.command(fixture.target_a, "restored"), nil, fixture.target_b.handlerGeneration)
        f.snapshot(1)
        assert.are.same(fixture.target_a, f.operations.attachment().target)
        assert.are.equal(0, vim.tbl_count(f.operations.pending()))
    end)

    it("rejects a Handler restart before start dispatch without a replacement mutation", function()
        local f = fixture.operations()
        local error
        f.operations.new("/work/a", function(value)
            error = value
        end)
        f.respond(1, { phase = "ready" })
        f.respond(2, { state = "choices", choices = { { selection = fixture.selection } }, unavailable = {} })
        f.selections[1].callback(f.selections[1].choices[1])
        f.respond(3, nil, { code = "STALE_HANDLER" })
        assert.are.equal("STALE_HANDLER", error.code)
        assert.are.equal(3, #f.calls)
        assert.are.equal(0, #f.streams)
    end)

    it("never retargets a delayed stop confirmation after restoration", function()
        local f = fixture.operations()
        local error
        f.operations.stop(fixture.target_a, function(value)
            error = value
        end)
        f.operations.restore(fixture.target_a.agentId, function() end)
        f.confirmations[1].callback(true)
        assert.are.equal("CANCELLED", error.code)
        assert.are.equal(1, #f.calls)
        assert.are.same(fixture.target_a, f.confirmations[1].target)
    end)

    it("captures cwd through delayed choice and retains identity before mutation", function()
        local f = fixture.operations()
        local result
        local tab, buffer = vim.api.nvim_get_current_tabpage(), vim.api.nvim_get_current_buf()
        f.operations.new("/work/a", function(error, target)
            result = { error, target }
        end)
        f.respond(1, { phase = "ready" }, nil, fixture.target_a.handlerGeneration)
        f.respond(
            2,
            {
                state = "choices",
                choices = {
                    {
                        selection = fixture.selection,
                        displayName = "Model A",
                        snapshotId = fixture.id(8),
                        contractFingerprint = string.rep("a", 64),
                    },
                },
                unavailable = {},
            }
        )
        f.selections[1].callback(f.selections[1].choices[1])
        assert.are.equal("/work/a", f.calls[3].options.cwd)
        assert.is_true(f.calls[3].options.timeout_ms > 45000)
        assert.is_true(vim.tbl_contains(f.calls[3].argv, "--expected-handler-generation"))
        assert.is_true(vim.tbl_contains(f.calls[3].argv, fixture.target_a.handlerGeneration))
        f.respond(3, fixture.command(fixture.target_a, "started"))
        assert.is_nil(result)
        vim.cmd.tabnew()
        f.snapshot(1)
        local origin = f.operations.attachment().origin
        vim.cmd.tabclose()
        assert.are.same({ tab = tab, buffer = buffer, cwd = "/work/a" }, origin)
        assert.is_nil(result[1])
        assert.are.same(fixture.target_a, result[2])
    end)

    it("inspects the pre-retained command after complete stdout loss without resubmission", function()
        local f = fixture.operations()
        f.operations.restore(fixture.target_a.agentId, function() end)
        f.respond(1, { phase = "ready" }, nil, fixture.target_a.handlerGeneration)
        f.respond(2, nil, { code = "UNAVAILABLE" })
        f.operations.inspect_pending(function() end)
        assert.are.same(
            { "agent", "command", fixture.id(301), "--handler-generation", fixture.target_a.handlerGeneration },
            f.calls[3].argv
        )
        assert.are.equal("restore", f.calls[2].argv[2])
        assert.are.equal(3, #f.calls)
    end)

    it("does not treat a transitional agent or paging error as zero agents", function()
        for _, phase in ipairs({ "starting", "restoring", "stopping" }) do
            local f = fixture.operations()
            local error
            f.operations.current("/work/a", function(value)
                error = value
            end)
            f.respond(1, fixture.page({ fixture.agent(fixture.target_a, phase) }))
            assert.are.equal("NOT_READY", error.code)
            assert.are.equal(1, #f.calls)
            assert.are.equal(0, #f.streams)
        end
        local f = fixture.operations()
        f.operations.current("/work/a", function() end)
        f.respond(1, nil, { code = "INVALID_PROTOCOL" })
        assert.are.equal(1, #f.calls)
    end)

    it("keeps the old attachment until a replacement snapshot is complete", function()
        local f = fixture.operations()
        f.operations.attach(fixture.target_a, function() end)
        f.snapshot(1)
        f.operations.attach(fixture.target_b, function() end)
        assert.is_false(f.streams[1].closed)
        f.snapshot(2)
        assert.is_true(f.streams[1].closed)
        assert.are.same(fixture.target_b, f.operations.attachment().target)
    end)
end)