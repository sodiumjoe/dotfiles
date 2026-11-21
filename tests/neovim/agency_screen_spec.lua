package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
dofile(vim.env.DOTFILES_TEST_ROOT .. "/home/.config/nvim/lua/sodium/plugins/agentic.lua").config()
require("snacks").setup({ picker = vim.tbl_extend("force", dofile(vim.env.DOTFILES_TEST_ROOT .. "/home/.config/nvim/lua/sodium/plugins/pickers.lua").opts.picker, { enabled = true }) })

describe("Agency screen", function()
    local f, screen, lines
    local readme = vim.env.DOTFILES_TEST_ROOT .. "/README.md"
    before_each(function()
        lines = vim.o.lines
        vim.o.lines = 60
        f = require("fixtures.agency_native").new()
        screen = require("sodium.agency.screen")
    end)
    after_each(function()
        vim.o.lines = lines
        f.close()
    end)
    local function editor()
        for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
            if vim.w[win].agentic_bufnr == nil and vim.api.nvim_win_get_config(win).relative == "" then
                return win
            end
        end
    end
    local function half()
        return math.floor(vim.o.lines * 0.5)
    end

    it("derives conversation, split, document and none from the windows in the tab", function()
        assert.are.equal("split", screen.state())
        f.manager.widget:hide()
        assert.are.equal("document", screen.state())
        require("agentic.session_registry").show_session(f.manager.session_key)
        assert.are.equal("split", screen.state())
        vim.api.nvim_win_close(editor(), true)
        assert.are.equal("conversation", screen.state())
        require("agentic.session_registry").destroy(f.manager.session_key)
        assert.are.equal("none", screen.state())
    end)

    it("treats a session shown in another tab as document in this one", function()
        local first = vim.api.nvim_get_current_tabpage()
        vim.cmd("tabnew")
        local second = vim.api.nvim_get_current_tabpage()
        assert.are.equal("document", screen.state(second))
        assert.are.equal("split", screen.state(first))
        assert.are.equal(first, f.manager.widget:get_visible_tab_id())
    end)

    it("opens the last document above the chat at half height without the chat's window options", function()
        vim.api.nvim_win_call(editor(), function()
            vim.cmd("edit " .. vim.fn.fnameescape(readme))
        end)
        local buf = vim.fn.bufnr(readme)
        vim.api.nvim_win_close(editor(), true)
        assert.are.equal("conversation", screen.state())
        local chat, current = f.manager.widget.win_nrs.chat, vim.api.nvim_get_current_win()
        assert.are_not.equal("", vim.wo[chat].winhighlight)
        local win = screen.ensure_document()
        assert.are.equal("split", screen.state())
        assert.are.equal(buf, vim.api.nvim_win_get_buf(win))
        assert.are.equal(half(), vim.api.nvim_win_get_height(win))
        assert.is_true(vim.fn.win_screenpos(win)[1] < vim.fn.win_screenpos(chat)[1])
        assert.are.equal(vim.fn.win_screenpos(chat)[2], vim.fn.win_screenpos(win)[2])
        assert.are.equal("", vim.wo[win].winhighlight)
        assert.are.equal(vim.go.statuscolumn, vim.wo[win].statuscolumn)
        assert.is_nil(vim.w[win].agentic_bufnr)
        assert.is_true(vim.wo[win].winfixheight)
        assert.are.equal(current, vim.api.nvim_get_current_win())
        assert.are.equal(win, screen.ensure_document())
    end)

    it("puts the document back at half height in split and leaves conversation alone", function()
        local doc = editor()
        vim.api.nvim_win_set_height(doc, 5)
        screen.resize()
        assert.are.equal(half(), vim.api.nvim_win_get_height(doc))
        vim.api.nvim_win_close(doc, true)
        local chat = f.manager.widget.win_nrs.chat
        local height = vim.api.nvim_win_get_height(chat)
        screen.resize()
        assert.are.equal(height, vim.api.nvim_win_get_height(chat))
        assert.are.equal("conversation", screen.state())
    end)

    it("holds the document height when a panel closes in split", function()
        local doc = editor()
        assert.are.equal(half(), vim.api.nvim_win_get_height(doc))
        assert.is_true(vim.wo[doc].winfixheight)
        f.manager.file_list:add(readme)
        assert.is_true(require("agentic.utils.buf_helpers").is_win_usable(f.manager.widget.win_nrs.files))
        f.manager.file_list:clear()
        assert.is_falsy(require("agentic.utils.buf_helpers").is_win_usable(f.manager.widget.win_nrs.files))
        assert.are.equal(half(), vim.api.nvim_win_get_height(doc))
    end)

    it("opens a new document above the chat when the only split beside it is a tool window", function()
        for _, filetype in ipairs({ "qf", "fugitive" }) do
            local tool = editor()
            vim.bo[vim.api.nvim_win_get_buf(tool)].filetype = filetype
            assert.are.equal("split", screen.state())
            assert.is_nil(screen.document_window())
            local win = screen.ensure_document()
            assert.are_not.equal(tool, win)
            assert.is_true(vim.fn.win_screenpos(win)[1] < vim.fn.win_screenpos(f.manager.widget.win_nrs.chat)[1])
            vim.api.nvim_win_close(win, true)
        end
    end)

    local function cycle()
        for _, mapping in ipairs(require("sodium.plugins.agentic").keys) do
            if mapping[1] == "<leader>ac" then return mapping[2]() end
        end
        error("missing current mapping")
    end

    it("cycles split, document and conversation with <leader>ac and keeps the document buffer", function()
        vim.api.nvim_win_call(editor(), function()
            vim.cmd("edit " .. vim.fn.fnameescape(readme))
        end)
        local buf = vim.fn.bufnr(readme)
        assert.are.equal("split", screen.state())
        cycle()
        assert.are.equal("document", screen.state())
        assert.are.same({ editor() }, screen.documents())
        assert.is_false(vim.wo[editor()].winfixheight)
        cycle()
        assert.are.equal("conversation", screen.state())
        assert.are.equal(vim.api.nvim_get_current_tabpage(), f.manager.widget:get_visible_tab_id())
        cycle()
        assert.are.equal("split", screen.state())
        assert.are.equal(buf, vim.api.nvim_win_get_buf(editor()))
        assert.are.equal(editor(), vim.api.nvim_get_current_win())
    end)

    it("closes every split beside the chat when the cycle leaves document", function()
        cycle()
        vim.cmd("split")
        vim.cmd("copen")
        assert.are.equal(3, #screen.documents())
        cycle()
        assert.are.equal("conversation", screen.state())
        assert.are.same({}, screen.documents())
    end)

    it("gives conversation with a taller chat when the document closes in split", function()
        local chat = f.manager.widget.win_nrs.chat
        local height = vim.api.nvim_win_get_height(chat)
        vim.api.nvim_win_close(editor(), true)
        assert.are.equal("conversation", screen.state())
        assert.is_true(vim.api.nvim_win_get_height(chat) > height)
    end)

    local function chat_key(key, text)
        f.flush()
        local chat = f.manager.widget.win_nrs.chat
        local buf = vim.api.nvim_win_get_buf(chat)
        vim.bo[buf].modifiable = true
        vim.api.nvim_buf_set_lines(buf, 0, -1, false, { "see " .. text })
        vim.api.nvim_set_current_win(chat)
        vim.api.nvim_win_set_cursor(chat, { 1, 5 })
        vim.fn.maparg(key, "n", false, true).callback()
        f.flush()
        return chat, buf
    end
    local function in_document(chat, buf, line)
        local doc = vim.api.nvim_get_current_win()
        assert.are.equal("split", screen.state())
        assert.is_nil(vim.w[doc].agentic_bufnr)
        assert.are.equal(vim.fn.bufnr(readme), vim.api.nvim_win_get_buf(doc))
        if line then assert.are.equal(line, vim.api.nvim_win_get_cursor(doc)[1]) end
        assert.are.equal(buf, vim.api.nvim_win_get_buf(chat))
        assert.are.same({ 1, 5 }, vim.api.nvim_win_get_cursor(chat))
        return doc
    end

    it("opens a chat path reference in a new document window from conversation", function()
        vim.api.nvim_win_close(editor(), true)
        assert.are.equal("conversation", screen.state())
        local chat, buf = chat_key("gf", "README.md:3")
        local doc = in_document(chat, buf, 3)
        assert.is_true(vim.fn.win_screenpos(doc)[1] < vim.fn.win_screenpos(chat)[1])
    end)

    it("opens a chat path reference in the existing document window from split", function()
        local doc, count = editor(), #vim.api.nvim_tabpage_list_wins(0)
        local chat, buf = chat_key("gf", "README.md:3")
        assert.are.equal(doc, in_document(chat, buf, 3))
        assert.are.equal(count, #vim.api.nvim_tabpage_list_wins(0))
    end)

    it("opens a bare chat path through the gF fallback in the document window", function()
        vim.api.nvim_win_close(editor(), true)
        local chat, buf = chat_key("gf", "README.md")
        local doc = in_document(chat, buf)
        assert.are.equal(half(), vim.api.nvim_win_get_height(doc))
        assert.is_true(vim.wo[doc].winfixheight)
    end)

    it("opens a picked file from the chat in the document window at its line", function()
        vim.api.nvim_win_close(editor(), true)
        f.flush()
        local chat = f.manager.widget.win_nrs.chat
        local buf = vim.api.nvim_win_get_buf(chat)
        vim.api.nvim_set_current_win(chat)
        local cursor = vim.api.nvim_win_get_cursor(chat)
        local picker = Snacks.picker({ items = { { file = readme, text = "README.md", pos = { 3, 0 } } } })
        assert.is_true(vim.wait(2000, function() return picker:current() ~= nil end))
        assert.are.equal(chat, picker.main)
        local action = require("snacks.picker.core.actions").resolve("confirm", picker)
        action.action(picker, picker:current(), action)
        f.flush()
        local doc = vim.api.nvim_get_current_win()
        assert.are.equal("split", screen.state())
        assert.is_nil(vim.w[doc].agentic_bufnr)
        assert.are.equal(vim.fn.bufnr(readme), vim.api.nvim_win_get_buf(doc))
        assert.are.same({ 3, 0 }, vim.api.nvim_win_get_cursor(doc))
        assert.are.equal(buf, vim.api.nvim_win_get_buf(chat))
        assert.are.same(cursor, vim.api.nvim_win_get_cursor(chat))
    end)
end)
