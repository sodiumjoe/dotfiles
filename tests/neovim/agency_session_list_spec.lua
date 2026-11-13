require("snacks").setup({ picker = { enabled = true } })
local List = require("sodium.agency.session_list")

describe("Agency session list presentation", function()
    local pickers
    before_each(function() pickers = {} end)
    after_each(function() for _, picker in ipairs(pickers) do picker:close() end end)

    local function view(id, at, extra)
        return vim.tbl_deep_extend("force", { live = true, display = { title = "title " .. id }, record = { version = 3, phase = "ready",
            definition = { agentId = id, backendId = "claude-agent-acp", cwd = "/tmp/" .. id }, settings = { configValues = { model = "opus" } },
            launch = { handlerGeneration = "h", providerGeneration = "p" }, lastActivityAt = at } }, extra or {})
    end

    it("formats ages and models and never shows a negative age", function()
        local now = List.epoch("2026-11-13T12:00:00.000Z")
        assert.are.equal("now", List.age("2026-11-13T11:59:30.000Z", now))
        assert.are.equal("12m", List.age("2026-11-13T11:48:00Z", now))
        assert.are.equal("3h", List.age("2026-11-13T09:00:00Z", now))
        assert.are.equal("2d", List.age("2026-11-11T12:00:00Z", now))
        assert.are.equal("now", List.age("2026-11-13T12:05:00Z", now))
        assert.are.equal("", List.age(nil, now))
        assert.are.equal("Claude · opus", List.model(view("a").record))
        local codex = view("b")
        codex.record.definition.backendId, codex.record.settings = "codex-acp", {}
        assert.are.equal("Codex", List.model(codex.record))
    end)

    it("orders timed rows newest first, then untimed rows in source order, then issues", function()
        local items = {
            List.item(view("old", "2026-11-12T00:00:00Z"), { status = "Idle" }),
            { title = "problem", issue = { code = "X" } },
            List.item(view("none-1"), { status = "Idle" }),
            List.item(view("new", "2026-11-13T00:00:00Z"), { status = "Idle" }),
            List.item(view("none-2"), { status = "Idle" }),
        }
        local order = {}
        for _, item in ipairs(List.order(items)) do order[#order + 1] = item.view and item.view.record.definition.agentId or item.title end
        assert.are.same({ "new", "old", "none-1", "none-2", "problem" }, order)
    end)

    it("uses the record title for stopped sessions and includes the model in rows", function()
        local item = List.item(view("s", nil, { live = false, display = vim.NIL, record = { phase = "stopped", title = "saved title" } }), { status = "Stopped" })
        assert.are.equal("saved title", item.title)
        local picker = Snacks.picker({ title = "test", items = { item }, format = List.format, preview = List.preview(nil) })
        pickers[#pickers + 1] = picker
        assert.is_true(vim.wait(1000, function() return picker.list:count() == 1 and picker.list.win.win ~= nil end))
        vim.api.nvim_win_set_width(picker.list.win.win, 100)
        picker.list:update({ force = true })
        local line = vim.api.nvim_buf_get_lines(picker.list.win.buf, 0, 1, false)[1]
        assert.is_truthy(line:find("saved title", 1, true))
        assert.is_truthy(line:find("Claude · opus", 1, true))
        assert.is_truthy(line:find("Stopped", 1, true))
    end)

    it("loads an excerpt once per row and ignores a late reply for a row that is no longer current", function()
        local requests = {}
        local load = function(excerpt, callback) requests[#requests + 1] = { excerpt = excerpt, callback = callback } end
        local picker = Snacks.picker({ title = "test", items = { List.item(view("a", "2026-11-13T00:00:02Z"), { status = "Idle" }),
            List.item(view("b", "2026-11-13T00:00:01Z"), { status = "Idle" }) }, format = List.format, preview = List.preview(load) })
        pickers[#pickers + 1] = picker
        local function preview() return table.concat(vim.api.nvim_buf_get_lines(picker.preview.win.buf, 0, -1, false), "\n") end
        assert.is_true(vim.wait(1000, function() return #requests == 1 and preview():find("Loading conversation…", 1, true) ~= nil end))
        assert.are.equal("a", requests[1].excerpt.agentId)
        picker.list:move(1)
        assert.is_true(vim.wait(1000, function() return #requests == 2 end))
        requests[1].callback(nil, { state = "excerpt", source = "live", turns = { { role = "user", text = "late for a" } }, reason = vim.NIL })
        requests[2].callback(nil, { state = "excerpt", source = "history", turns = { { role = "user", text = "question b" }, { role = "agent", text = "answer b" } }, reason = vim.NIL })
        assert.is_true(vim.wait(1000, function() return preview():find("‹ agent: answer b", 1, true) ~= nil end))
        assert.is_falsy(preview():find("late for a", 1, true))
        picker.list:move(-1)
        assert.is_true(vim.wait(1000, function() return preview():find("› you: late for a", 1, true) ~= nil end))
        assert.are.equal(2, #requests)
    end)

    it("explains a missing excerpt from an old devbox", function()
        local item = List.item(view("r", "2026-11-13T00:00:00Z"), { status = "Idle" })
        item.excerpt.hostId = string.rep("b", 64)
        local picker = Snacks.picker({ title = "test", items = { item }, format = List.format,
            preview = List.preview(function(_, callback) callback({ code = "STALE_HANDLER", message = "stale handler" }) end) })
        pickers[#pickers + 1] = picker
        assert.is_true(vim.wait(1000, function()
            return table.concat(vim.api.nvim_buf_get_lines(picker.preview.win.buf, 0, -1, false), "\n"):find("Excerpt unavailable: update this devbox", 1, true) ~= nil
        end))
    end)

    it("shows and clears the loading suffix", function()
        local picker = Snacks.picker({ title = "Base", items = {}, show_empty = true, format = List.format })
        pickers[#pickers + 1] = picker
        List.loading(picker, "Base", true)
        assert.are.equal("Base (loading…)", picker.title)
        List.loading(picker, "Base", false)
        assert.are.equal("Base", picker.title)
    end)
end)