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

    it("orders local sessions before remote ones, each newest first", function()
        local remote_new = List.item(view("remote-new", "2026-11-14T00:00:00Z"), { status = "Idle" })
        local remote_old = List.item(view("remote-old", "2026-11-11T00:00:00Z"), { status = "Idle" })
        remote_new.remote, remote_old.remote = true, true
        local items = {
            remote_old,
            List.item(view("local-old", "2026-11-12T00:00:00Z"), { status = "Idle" }),
            remote_new,
            List.item(view("local-new", "2026-11-13T00:00:00Z"), { status = "Idle" }),
        }
        local order = {}
        for _, item in ipairs(List.order(items)) do order[#order + 1] = item.view.record.definition.agentId end
        assert.are.same({ "local-new", "local-old", "remote-new", "remote-old" }, order)
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

    it("explains a missing excerpt from an outdated local Handler", function()
        local picker = Snacks.picker({ title = "test", items = { List.item(view("l", "2026-11-13T00:00:00Z"), { status = "Idle" }) }, format = List.format,
            preview = List.preview(function(_, callback) callback({ code = "INVALID_PROTOCOL", message = "unknown command" }) end) })
        pickers[#pickers + 1] = picker
        assert.is_true(vim.wait(1000, function()
            return table.concat(vim.api.nvim_buf_get_lines(picker.preview.win.buf, 0, -1, false), "\n"):find("Excerpt unavailable: restart the Agency Handler", 1, true) ~= nil
        end))
    end)

    it("never renders a row wider than a narrow list", function()
        local item = List.item(view("n", "2026-11-13T00:00:00Z", { display = { title = string.rep("界面 long title ", 4) } }), { status = "Needs recovery" })
        item.label = "stripelet-loading"
        for width = 12, 30 do
            local text = ""
            for _, chunk in ipairs(List.format(item, { _agency_label_width = 19 })[1].resolve(width)) do text = text .. chunk[1] end
            assert.is_true(vim.fn.strdisplaywidth(text) <= width - 1, width .. ": " .. text)
        end
    end)
end)