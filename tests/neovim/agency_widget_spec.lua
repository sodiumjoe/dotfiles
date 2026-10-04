describe("Agency independent widget", function()
    local widgets
    before_each(function()
        widgets = {}
    end)
    after_each(function()
        for _, widget in ipairs(widgets) do
            widget.destroy()
        end
    end)
    local function make()
        local widget = require("sodium.agency.widget").new(vim.api.nvim_get_current_tabpage(), function() end)
        widgets[#widgets + 1] = widget
        return widget
    end
    it("uses distinct identities without modifying native headers", function()
        vim.t.agentic_headers = { chat = { title = "native" } }
        local headers = vim.deepcopy(vim.t.agentic_headers)
        local a, b = make(), make()
        a.show()
        b.show()
        assert.are_not.equal(a.buf_nrs.chat, b.buf_nrs.chat)
        assert.are_not.equal(a.augroup, b.augroup)
        assert.are.equal(a.buf_nrs.chat, vim.w[a.win_nrs.chat].agency_bufnr)
        assert.is_nil(vim.w[a.win_nrs.chat].agentic_bufnr)
        a.render_header("chat", "model · cwd")
        assert.are.same(headers, vim.t.agentic_headers)
        assert.are.equal(1, #vim.api.nvim_list_tabpages())
    end)
    it("redirects foreign buffers only from its own windows", function()
        local widget = make()
        widget.show()
        local foreign = vim.api.nvim_create_buf(false, true)
        vim.api.nvim_set_current_win(widget.win_nrs.chat)
        vim.api.nvim_win_set_buf(widget.win_nrs.chat, foreign)
        vim.wait(30, function()
            return vim.api.nvim_get_current_buf() == foreign
        end)
        assert.are.equal(widget.buf_nrs.chat, vim.api.nvim_win_get_buf(widget.win_nrs.chat))
        assert.are.equal(foreign, vim.api.nvim_get_current_buf())
        vim.api.nvim_buf_delete(foreign, { force = true })
    end)
    it("preserves draft buffers while hiding its splits", function()
        local widget = make()
        widget.show()
        vim.api.nvim_buf_set_lines(widget.buf_nrs.input, 0, -1, false, { "unsent" })
        widget.hide()
        assert.is_false(widget.is_open())
        assert.are.same({ "unsent" }, vim.api.nvim_buf_get_lines(widget.buf_nrs.input, 0, -1, false))
        widget.show()
        assert.is_true(widget.is_open())
    end)
    it("uses the configured bottom height and right-hand prompt stack", function()
        local widget = make()
        widget.show()
        local chat, input =
            vim.api.nvim_win_get_position(widget.win_nrs.chat), vim.api.nvim_win_get_position(widget.win_nrs.input)
        assert.are.equal(chat[1], input[1])
        assert.is_true(input[2] > chat[2])
    end)
    for _, agency_first in ipairs({ true, false }) do
        for _, destroy_agency_first in ipairs({ true, false }) do
            it(
                "coexists with a native widget in creation/destruction order "
                    .. tostring(agency_first)
                    .. "/"
                    .. tostring(destroy_agency_first),
                function()
                    local native, agency
                    local function create_native()
                        vim.t.agentic_headers = nil
                        native = require("agentic.ui.chat_widget"):new(vim.api.nvim_get_current_tabpage(), function()
                            error("native prompt called")
                        end)
                        native:show({ focus_prompt = false })
                    end
                    local function create_agency()
                        agency = make()
                        agency.show()
                    end
                    if agency_first then
                        create_agency()
                        create_native()
                    else
                        create_native()
                        create_agency()
                    end
                    local headers = vim.deepcopy(vim.t.agentic_headers)
                    local name = vim.api.nvim_buf_get_name(native.buf_nrs.chat)
                    agency.render_header("todos", "pending")
                    assert.are.same(headers, vim.t.agentic_headers)
                    assert.are.equal(name, vim.api.nvim_buf_get_name(native.buf_nrs.chat))
                    if destroy_agency_first then
                        agency.destroy()
                        assert.is_true(native:is_open())
                        assert.is_true(vim.api.nvim_buf_is_valid(native.buf_nrs.input))
                        native:destroy()
                    else
                        native:destroy()
                        assert.is_true(agency.is_open())
                        assert.is_true(vim.api.nvim_buf_is_valid(agency.buf_nrs.input))
                        agency.destroy()
                    end
                end
            )
        end
    end
end)