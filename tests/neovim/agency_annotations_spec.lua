package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
describe("Agency annotations", function()
    local f, control, transport, screen, annotations, notifications, buf
    before_each(function()
        f = require("fixtures.agency_native").new()
        control = require("fixtures.agency_control")
        transport = control.operations()
        package.loaded["sodium.agency"] = nil
        notifications = {}
        require("sodium.agency").setup({
            client = {
                command = function(argv, options, callback)
                    transport.calls[#transport.calls + 1] = { argv = argv, options = options, callback = callback }
                end,
            },
            notify = function(value)
                notifications[#notifications + 1] = value
            end,
            request = control.requests(transport.calls),
        })
        screen, annotations = require("sodium.agency.screen"), require("sodium.annotations")
        buf = vim.api.nvim_create_buf(true, false)
        vim.api.nvim_buf_set_name(buf, vim.fn.getcwd() .. "/annotated.lua")
        vim.api.nvim_buf_set_lines(buf, 0, -1, false, { "local a = 1", "local b = 2", "return a + b" })
        vim.api.nvim_win_set_buf(screen.document_window(), buf)
        annotations.set(buf, 1, 1, "rename b")
    end)
    after_each(function()
        annotations.clear(buf)
        f.close()
        pcall(vim.api.nvim_buf_delete, buf, { force = true })
    end)
    local function send()
        for _, mapping in ipairs(require("sodium.plugins.agentic").keys) do
            if mapping[1] == "<leader>ai" then
                mapping[2]()
                f.flush()
                return f.request("session/prompt")
            end
        end
        error("missing <leader>ai mapping")
    end

    it("sends the annotations, clears them on admission and switches to the conversation", function()
        assert.are.equal("split", screen.state())
        local prompt = send()
        local texts = vim.tbl_map(function(block)
            return block.text
        end, prompt.params.prompt)
        assert.is_truthy(vim.tbl_contains(texts, "Address each captured annotation."))
        local block = texts[#texts]
        assert.is_truthy(block:find("File: annotated.lua", 1, true))
        assert.is_truthy(block:find("Lines: 2-2", 1, true))
        assert.is_truthy(block:find("> local b = 2", 1, true))
        assert.is_truthy(block:find("Note: rename b", 1, true))
        assert.are.equal(1, #annotations.annotations())
        f.state(prompt.params._meta.agency.submissionId, "running")
        assert.are.same({}, annotations.annotations())
        assert.are.equal("conversation", screen.state())
    end)

    it("leaves the layout alone when admission arrives after the tab changed", function()
        local first, prompt = vim.api.nvim_get_current_tabpage(), send()
        vim.cmd("tabnew")
        f.state(prompt.params._meta.agency.submissionId, "running")
        assert.are.same({}, annotations.annotations())
        assert.are.equal("document", screen.state())
        assert.are.equal(first, f.manager.widget:get_visible_tab_id())
        assert.are.equal("split", screen.state(first))
    end)

    it("keeps the annotations and the split when the Handler rejects the prompt", function()
        local prompt = send()
        f.client:_handle_message({
            id = prompt.id,
            error = {
                code = -32000,
                message = "agent busy",
                data = { agency = { code = "BUSY", message = "agent busy" } },
            },
        })
        f.flush()
        assert.is_truthy(transport.pending("agents"))
        transport.answer("agents", control.roster({ control.row(control.target_a, true, vim.fn.getcwd()) }))
        f.flush()
        assert.are.equal(1, #annotations.annotations())
        assert.are.equal("split", screen.state())
        assert.are.equal(f.manager, require("agentic.session_registry").current())
        assert.is_truthy(vim.tbl_contains(notifications, "agent busy"))
    end)
end)