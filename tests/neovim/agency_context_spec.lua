describe("Agency captured text context", function()
    local context, buf
    before_each(function()
        context = require("sodium.agency.context")
        buf = vim.api.nvim_create_buf(false, true)
        vim.api.nvim_buf_set_lines(buf, 0, -1, false, { "unsaved α", "second" })
    end)
    after_each(function()
        if buf and vim.api.nvim_buf_is_valid(buf) then
            vim.api.nvim_buf_delete(buf, { force = true })
        end
    end)
    it("captures modified text before focus or buffer changes", function()
        vim.api.nvim_buf_set_name(buf, "/tmp/agency context.lua")
        local captured = context.capture(buf, "file")
        vim.api.nvim_buf_set_lines(buf, 0, -1, false, { "later" })
        local text = assert(context.encode({ text = "inspect", files = { captured } }, {}, {}, {}))
        assert.is_truthy(text:find("/tmp/agency context.lua", 1, true))
        assert.is_truthy(text:find("unsaved α", 1, true))
        assert.is_nil(text:find("later", 1, true))
    end)
    it("labels unnamed selections with their buffer identity", function()
        local captured = context.capture(buf, { first = 2, last = 2 })
        local text = assert(context.encode("question", { captured.selection }, {}, {}))
        assert.is_truthy(text:find("[buffer:" .. buf .. "]", 1, true))
        assert.is_truthy(text:find("second", 1, true))
        assert.is_nil(text:find("unsaved", 1, true))
    end)
    it("encodes diagnostics and annotations as labelled text", function()
        local text = assert(context.encode("q", {}, {
            { file_path = "/tmp/a b.lua", lnum = 4, col = 2, message = "bad\nvalue", severity = 1 },
        }, { { text = "review this line" } }))
        assert.is_truthy(text:find("/tmp/a b.lua:5:3", 1, true))
        assert.is_truthy(text:find("bad\nvalue", 1, true))
        assert.is_truthy(text:find("Annotations", 1, true))
        assert.is_truthy(text:find("review this line", 1, true))
    end)
    it("rejects binary context without returning a partial prompt", function()
        local text, err = context.encode(
            { text = "keep", files = { { path = "/tmp/a", lines = { "a\0b" }, modified = true } } },
            {},
            {},
            {}
        )
        assert.is_nil(text)
        assert.are.equal("UNSUPPORTED_CONTEXT", err.code)
    end)
    it("rejects image and audio references", function()
        for _, path in ipairs({ "/tmp/x.png", "/tmp/x.mp3" }) do
            local text, err = context.encode({ text = "keep", files = { { path = path } } }, {}, {}, {})
            assert.is_nil(text)
            assert.are.equal("UNSUPPORTED_CONTEXT", err.code)
        end
    end)
    it("checks UTF-8 bytes of the combined prompt", function()
        assert.is_truthy(context.encode(string.rep("α", 131072), {}, {}, {}))
        local text, err = context.encode(string.rep("α", 131073), {}, {}, {})
        assert.is_nil(text)
        assert.are.equal("INPUT_TOO_LARGE", err.code)
    end)
    it("rejects malformed UTF-8 instead of sending a corrupted prompt", function()
        local text, err = context.encode("question " .. string.char(192, 175), {}, {}, {})
        assert.is_nil(text)
        assert.are.equal("UNSUPPORTED_CONTEXT", err.code)
    end)
    it("uses separator-aware ancestors and handles root cwd", function()
        assert.is_true(context.inside("/", "/tmp/a"))
        assert.is_true(context.inside("/tmp/agent", "/tmp/agent/a"))
        assert.is_false(context.inside("/tmp/agent", "/tmp/agent-other/a"))
    end)
    it("confirms the resolved outside symlink rather than its inside spelling", function()
        local root = vim.fn.tempname()
        vim.fn.mkdir(root .. "/inside", "p")
        vim.fn.mkdir(root .. "/outside", "p")
        assert(vim.uv.fs_symlink(root .. "/outside", root .. "/inside/link"))
        local original, prompt, answer = vim.ui.select
        vim.ui.select = function(_, opts, callback)
            prompt = opts.prompt
            callback("Include")
        end
        context.confirm_external(root .. "/inside", { { path = root .. "/inside/link/a" } }, function(ok)
            answer = ok
        end)
        vim.ui.select = original
        vim.fn.delete(root, "rf")
        assert.is_true(answer)
        assert.is_truthy(prompt:find(root .. "/outside/a", 1, true))
    end)
end)