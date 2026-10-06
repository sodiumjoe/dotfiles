describe("Agency native captured context", function()
    local context, buf, manager
    before_each(function()
        context = require("sodium.agency.context")
        buf = vim.api.nvim_create_buf(false, true)
        vim.api.nvim_buf_set_lines(buf, 0, -1, false, { "unsaved α", "second" })
        local selection = vim.api.nvim_create_buf(false, true)
        local files = vim.api.nvim_create_buf(false, true)
        local diagnostics = vim.api.nvim_create_buf(false, true)
        manager = { code_selection = require("agentic.ui.code_selection"):new(selection, function() end),
            file_list = require("agentic.ui.file_list"):new(files, function() end),
            diagnostics_list = require("agentic.ui.diagnostics_list"):new(diagnostics, function() end),
            buffers = { selection, files, diagnostics } }
    end)
    after_each(function()
        for _, value in ipairs({ buf, unpack(manager.buffers) }) do
            if vim.api.nvim_buf_is_valid(value) then vim.api.nvim_buf_delete(value, { force = true }) end
        end
    end)
    it("captures unsaved text before focus or buffer changes and adds it as native selection", function()
        local captured = context.capture(buf)
        vim.api.nvim_buf_set_lines(buf, 0, -1, false, { "later" })
        context.add(manager, captured)
        local selection = manager.code_selection:get_selections()[1]
        assert.are.same({ "unsaved α", "second" }, selection.lines)
        assert.are.equal("[buffer:" .. buf .. "]", selection.file_path)
    end)
    it("preserves selected line ranges", function()
        context.add(manager, context.capture(buf, { first = 2, last = 2 }))
        assert.are.same({ "second" }, manager.code_selection:get_selections()[1].lines)
        assert.are.equal(2, manager.code_selection:get_selections()[1].start_line)
    end)
    it("uses native references without imposing a text-only media restriction", function()
        local path = vim.fn.tempname() .. ".png"
        vim.fn.writefile({ "fixture" }, path)
        context.add(manager, { path = path, modified = false })
        assert.are.same({ path }, manager.file_list:get_files())
        vim.fn.delete(path)
    end)
    it("adds diagnostics to the native list", function()
        context.add(manager, { diagnostics = { { bufnr = buf, file_path = "/tmp/a.lua", lnum = 4, col = 2, message = "bad", severity = 1 } } }, "diagnostics")
        assert.are.equal("bad", manager.diagnostics_list:get_diagnostics()[1].message)
    end)
    it("deletes only unchanged captured annotation threads", function()
        local original = package.loaded["comment-overlay.store"]
        local threads = { a = { { body = "old" } }, b = { { body = "later" } }, c = { { body = "added" } } }
        package.loaded["comment-overlay.store"] = { reload_if_changed = function() end, get_project_root = function() return "/work" end,
            get_thread = function(id) return threads[id] end, delete = function(id) threads[id] = nil end }
        context.accept_annotations({ { id = "a", project = "/work", thread = { { body = "old" } } },
            { id = "b", project = "/work", thread = { { body = "old" } } } })
        package.loaded["comment-overlay.store"] = original
        assert.is_nil(threads.a)
        assert.are.equal("later", threads.b[1].body)
        assert.is_not_nil(threads.c)
    end)
end)