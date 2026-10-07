package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path

describe("Agency picker layout", function()
    local f, picker, config, saved, snacks, close_win
    local function floating_windows()
        local count = 0
        for _, win in ipairs(vim.api.nvim_list_wins()) do
            local opts = vim.api.nvim_win_get_config(win)
            if opts.relative ~= "" and not opts.hide then count = count + 1 end
        end
        return count
    end
    before_each(function()
        snacks = _G.Snacks
        _G.Snacks = require("snacks")
        if not Snacks.did_setup then Snacks.setup({ picker = { enabled = true }, notifier = { enabled = false } }) end
        config = require("agentic.config")
        saved = { position = config.windows.position, height = config.windows.height,
            ratio = config.windows.stack_width_ratio, lines = vim.o.lines, columns = vim.o.columns }
        config.windows.position, config.windows.height, config.windows.stack_width_ratio = "bottom", 0.5, 0.3
        vim.o.lines, vim.o.columns = 60, 160
        f = require("fixtures.agency_native").new()
        f.manager.widget:hide()
        f.flush()
    end)
    after_each(function()
        if close_win then vim.api.nvim_win_close = close_win; close_win = nil end
        if picker then picker:close() end
        f.close()
        config.windows.position, config.windows.height, config.windows.stack_width_ratio = saved.position, saved.height, saved.ratio
        vim.o.lines, vim.o.columns = saved.lines, saved.columns
        _G.Snacks = snacks
    end)
    it("removes restored empty panel windows before attaching after a session restart", function()
        f.manager.widget:show()
        f.flush()
        local session = vim.fn.tempname()
        vim.cmd.mksession({ session, bang = true })
        require("agentic.session_registry").destroy_session(f.manager.tab_page_id)
        f.flush()
        vim.cmd.source(session)
        vim.fn.delete(session)
        f.flush()
        local restored = {}
        for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
            if vim.api.nvim_win_get_config(win).relative == "" then restored[#restored + 1] = win end
        end
        assert.are.equal(1, #restored)
        local attached
        picker = require("sodium.agency.picker").open({
            page = function(_, callback)
                vim.schedule(function() callback(nil, { agents = { f.row }, issues = {},
                    handlerGeneration = f.row.record.launch.handlerGeneration }) end)
            end,
            snapshot = function() end,
            notify = function() end,
            attach = function() attached = require("sodium.agency.agentic").open(f.row) end,
        })
        assert.is_true(vim.wait(1000, function() return #picker.opts.items == 1 and picker.shown end))
        picker.opts.confirm(picker, picker.opts.items[1])
        assert.is_true(vim.wait(1000, function() return attached ~= nil end))
        f.flush()
        local windows = vim.tbl_filter(function(win)
            return vim.api.nvim_win_get_config(win).relative == ""
        end, vim.api.nvim_tabpage_list_wins(0))
        assert.are.equal(3, #windows)
        assert.are.equal(2, #vim.fn.winlayout()[2])
        assert.are.equal(math.floor(vim.o.lines * 0.5), vim.api.nvim_win_get_height(attached.widget.win_nrs.chat))
    end)
    it("preserves real files, content, modified buffers, editor splits, and active panels", function()
        f.manager.widget:show()
        f.flush()
        local directory, windows, buffers = vim.fn.tempname(), {}, {}
        vim.fn.mkdir(directory)
        local function panel(name, opts)
            opts = opts or {}
            local buf = vim.api.nvim_create_buf(true, false)
            local path = directory .. "/" .. name
            if opts.file then vim.fn.writefile({}, path) end
            vim.api.nvim_buf_set_name(buf, path)
            if opts.content then vim.api.nvim_buf_set_lines(buf, 0, -1, false, { opts.content }) end
            vim.bo[buf].modified = opts.modified or false
            vim.bo[buf].buftype = opts.buftype or ""
            vim.bo[buf].filetype = opts.filetype or ""
            local win = vim.api.nvim_open_win(buf, false, { split = "below", win = -1, noautocmd = true })
            windows[#windows + 1], buffers[#buffers + 1] = win, buf
            return win
        end
        local ok, err = pcall(function()
            panel("󰻞 Agentic Chat | retained text-old-1", { content = "keep this text" })
            panel("󰦨 Prompt | modified-old-1", { modified = true })
            panel("󰻞 Agentic Chat | real file-old-1", { file = true })
            panel("󰦨 Prompt | scratch-old-1", { buftype = "nofile" })
            panel("󰻞 Agentic Chat | typed-old-1", { filetype = "lua" })
            panel("ordinary editor buffer")
            local stale = panel("󰦨 Prompt | submit: <C-s> | change mode: <S-Tab>-old-1")
            local current = vim.api.nvim_get_current_win()
            local input = f.manager.widget.win_nrs.input
            vim.api.nvim_win_set_width(input, math.floor((vim.o.columns - 1) * config.windows.stack_width_ratio))
            local width = vim.api.nvim_win_get_width(input)
            local equalalways = vim.o.equalalways
            assert.are.same({ stale }, require("sodium.agency.layout").cleanup())
            assert.are.equal(current, vim.api.nvim_get_current_win())
            assert.are.equal(width, vim.api.nvim_win_get_width(input))
            assert.are.equal(equalalways, vim.o.equalalways)
            for index = 1, #windows - 1 do assert.is_true(vim.api.nvim_win_is_valid(windows[index])) end
            assert.is_true(f.manager.widget:is_open())
        end)
        for _, win in ipairs(windows) do
            if vim.api.nvim_win_is_valid(win) then vim.api.nvim_win_close(win, true) end
        end
        for _, buf in ipairs(buffers) do
            if vim.api.nvim_buf_is_valid(buf) then vim.api.nvim_buf_delete(buf, { force = true }) end
        end
        vim.fn.delete(directory, "rf")
        assert.is_true(ok, err)
    end)
    it("keeps an editor window when the restored tab contains only panel placeholders", function()
        local buf = vim.api.nvim_create_buf(true, false)
        vim.api.nvim_buf_set_name(buf, vim.fn.tempname() .. "/󰦨 Prompt | restored-old-1")
        vim.api.nvim_win_set_buf(0, buf)
        require("sodium.agency.layout").cleanup()
        assert.are.equal("", vim.api.nvim_buf_get_name(vim.api.nvim_get_current_buf()))
        assert.are.equal("", vim.bo.buftype)
        assert.are.equal("leaf", vim.fn.winlayout()[1])
        vim.api.nvim_buf_delete(buf, { force = true })
    end)
    it("preserves chat proportions when removing a restored row above the active widget", function()
        local buffers, windows = {}, {}
        local titles = { "󰻞 Agentic Chat | Mode: Full access-old-1", "󰦨 Prompt | submit: <C-s> | change mode: <S-Tab>-old-1" }
        for index, title in ipairs(titles) do
            local buf = vim.api.nvim_create_buf(true, false)
            vim.api.nvim_buf_set_name(buf, vim.fn.tempname() .. "/" .. title)
            windows[index] = vim.api.nvim_open_win(buf, false, { split = index == 1 and "below" or "right",
                win = index == 1 and -1 or windows[1], noautocmd = true })
            buffers[index] = buf
        end
        f.manager.widget:show()
        f.flush()
        local input = f.manager.widget.win_nrs.input
        local width = vim.api.nvim_win_get_width(input)
        local closed = require("sodium.agency.layout").cleanup()
        for _, buf in ipairs(buffers) do vim.api.nvim_buf_delete(buf, { force = true }) end
        assert.are.same(windows, closed)
        assert.are.equal(width, vim.api.nvim_win_get_width(input))
    end)
    it("waits until asynchronously closing picker windows have disappeared", function()
        local attached, floats_at_attach
        picker = require("sodium.agency.picker").open({
            page = function(_, callback)
                vim.schedule(function() callback(nil, { agents = { f.row }, issues = {},
                    handlerGeneration = f.row.record.launch.handlerGeneration }) end)
            end,
            snapshot = function() end,
            notify = function() end,
            attach = function()
                floats_at_attach = floating_windows()
                attached = require("sodium.agency.agentic").open(f.row)
            end,
        })
        assert.is_true(vim.wait(1000, function() return #picker.opts.items == 1 and picker.shown end))
        local windows = {}
        for _, win in ipairs(picker.layout:get_wins()) do if win.win then windows[win.win] = true end end
        close_win = vim.api.nvim_win_close
        local original = close_win
        vim.api.nvim_win_close = function(win, force)
            if windows[win] then
                vim.defer_fn(function() if vim.api.nvim_win_is_valid(win) then original(win, force) end end, 50)
            else return original(win, force) end
        end
        picker.opts.confirm(picker, picker.opts.items[1])
        assert.is_true(vim.wait(1000, function() return attached ~= nil end))
        vim.api.nvim_win_close = close_win
        close_win = nil
        vim.wait(80, function() return false end)
        assert.are.equal(0, floats_at_attach)
        f.flush()
        assert.are.equal(0, floating_windows())
    end)
    for _, split in ipairs({ false, true }) do
        for _, visible in ipairs({ true, false }) do
            for _, existing in ipairs({ true, false }) do
                it("attaches with stable bottom splits " .. (existing and "in the existing tab" or "in a new tab") .. (visible and " from visible chat" or " from hidden chat") .. (split and " with editor splits" or ""), function()
                    if split then vim.cmd("vsplit") end
                    local editor_windows = vim.tbl_filter(function(win)
                        return vim.api.nvim_win_get_config(win).relative == ""
                    end, vim.api.nvim_tabpage_list_wins(0))
                    if visible then f.manager.widget:show(); f.flush() end
                    local row = vim.deepcopy(f.row)
                    if not existing then row.record.definition.agentId = require("fixtures.agency_control").target_b.agentId end
                    local attached, floats_at_attach = nil, nil
                    picker = require("sodium.agency.picker").open({
                        page = function(_, callback)
                            vim.schedule(function() callback(nil, { agents = { row }, issues = {},
                                handlerGeneration = row.record.launch.handlerGeneration }) end)
                        end,
                        snapshot = function() end,
                        notify = function() end,
                        attach = function()
                            floats_at_attach = floating_windows()
                            attached = require("sodium.agency.agentic").open(row)
                        end,
                    })
                    assert.is_true(vim.wait(1000, function() return #picker.opts.items == 1 and picker.shown end))
                    assert.is_true(floating_windows() > 0)
                    picker.opts.confirm(picker, picker.opts.items[1])
                    assert.is_true(vim.wait(1000, function() return attached ~= nil end))
                    f.flush()
                    assert.are.equal(0, floats_at_attach)
                    assert.are.equal(0, floating_windows())
                    if existing then
                        for _, win in ipairs(editor_windows) do assert.is_true(vim.api.nvim_win_is_valid(win)) end
                    end
                    local layout = vim.fn.winlayout()
                    assert.are.equal("col", layout[1])
                    assert.are.equal("row", layout[2][2][1])
                    local chat, input = attached.widget.win_nrs.chat, attached.widget.win_nrs.input
                    assert.are.equal(math.floor(vim.o.lines * 0.5), vim.api.nvim_win_get_height(chat))
                    assert.are.equal(vim.api.nvim_win_get_height(chat), vim.api.nvim_win_get_height(input))
                    assert.are.equal(attached.widget.buf_nrs.input, vim.api.nvim_get_current_buf())
                end)
            end
        end
    end
end)