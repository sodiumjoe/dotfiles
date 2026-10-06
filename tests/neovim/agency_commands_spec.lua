package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
describe("Agency native commands", function()
    local f, api
    before_each(function()
        f = require("fixtures.agency_native").new()
        package.loaded["sodium.agency"] = nil
        api = require("sodium.agency").setup({ notify = function() end })
    end)
    after_each(function() f.close() end)
    it("returns and toggles the existing native manager", function()
        local result
        api.current(function(err, manager) assert.is_nil(err); result = manager end)
        assert.are.equal(f.manager, result)
        assert.are.equal(f.manager, api.view_for_buffer(f.manager.widget.buf_nrs.chat))
        for _, frame in ipairs(f.frames) do assert.is_not.equal("session/new", frame.method) end
    end)
    it("captures context before native widget focus", function()
        local buffer = vim.api.nvim_create_buf(false, true)
        vim.api.nvim_set_current_win(f.manager.widget:find_first_non_widget_window())
        vim.api.nvim_set_current_buf(buffer)
        vim.api.nvim_buf_set_lines(buffer, 0, -1, false, { "captured before focus" })
        api.add_context()
        assert.are.same({ "captured before focus" }, f.manager.code_selection:get_selections()[1].lines)
        vim.api.nvim_buf_delete(buffer, { force = true })
    end)
    it("submits through native ACP and accepts annotations only on Handler admission", function()
        local accepted, outcome = 0
        api.annotations = function() return { { text = "annotation" } } end
        api.accept_annotations = function() accepted = accepted + 1 end
        assert.is_true(api.submit_text("review", { annotations = true }, function(value) outcome = value end))
        local prompt = f.request("session/prompt")
        assert.are.equal("annotation", prompt.params.prompt[#prompt.params.prompt].text)
        assert.are.equal(0, accepted)
        f.state(prompt.params._meta.agency.submissionId, "running")
        assert.are.equal(1, accepted)
        assert.are.equal("accepted", outcome.state)
    end)
    it("rejects busy annotation submission without clearing or staging it", function()
        local outcome
        api.annotations = function() return { { text = "keep" } } end
        f.state("other-turn", "running")
        assert.is_false(api.submit_text("review", { annotations = true }, function(value) outcome = value end))
        assert.are.equal("rejected", outcome.state)
        assert.are.equal(0, #(f.manager._agency_pending_context or {}))
    end)
    it("detaches native views without cancelling or stopping providers", function()
        f.state("shared-turn", "running")
        api.detach()
        assert.is_true(f.manager._agency_destroyed)
        for _, frame in ipairs(f.frames) do assert.is_not.equal("session/cancel", frame.method) end
    end)
end)