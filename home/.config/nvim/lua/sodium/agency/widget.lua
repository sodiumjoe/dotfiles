local M = {}
local next_id = 0
local panels = {
    chat = "AgenticChat",
    input = "AgenticInput",
    todos = "AgenticTodos",
    code = "AgenticCode",
    files = "AgenticFiles",
    diagnostics = "AgenticDiagnostics",
}

function M.new(tab, on_submit)
    next_id = next_id + 1
    local config = require("agentic.config")
    local helpers = require("agentic.utils.buf_helpers")
    local api = { buf_nrs = {}, win_nrs = {}, headers = {}, identity = next_id, tab = tab }
    local destroyed, closing = false, false
    api.augroup = vim.api.nvim_create_augroup("SodiumAgencyView_" .. next_id, { clear = true })
    for name, filetype in pairs(panels) do
        local buf = vim.api.nvim_create_buf(false, true)
        api.buf_nrs[name] = buf
        vim.b[buf].agency_view = api.identity
        vim.api.nvim_buf_set_name(buf, "agency://" .. next_id .. "/" .. name)
        for key, value in pairs({
            buftype = "nofile",
            bufhidden = "hide",
            swapfile = false,
            buflisted = false,
            modifiable = name == "input",
            filetype = filetype,
        }) do
            vim.bo[buf][key] = value
        end
        helpers.multi_keymap_set(config.keymaps.widget.close, buf, function()
            api.hide()
        end, { desc = "Agency: hide view" })
        helpers.multi_keymap_set(config.keymaps.widget.switch_provider, buf, function()
            vim.cmd("AgencyNew")
        end, { desc = "Agency: new agent" })
        helpers.keymap_set(buf, "n", "<C-c>", function()
            vim.cmd("AgencyCancel")
        end, { desc = "Agency: cancel observed turn" })
    end
    helpers.multi_keymap_set(
        config.keymaps.prompt.submit,
        api.buf_nrs.input,
        on_submit,
        { desc = "Agency: submit text" }
    )
    local function editor_window()
        if not vim.api.nvim_tabpage_is_valid(tab) then
            return
        end
        for _, win in ipairs(vim.api.nvim_tabpage_list_wins(tab)) do
            if
                vim.w[win].agency_bufnr == nil
                and vim.w[win].agentic_bufnr == nil
                and vim.api.nvim_win_get_config(win).relative == ""
            then
                return win
            end
        end
    end
    local function open(name, anchor, split, size)
        local win = api.win_nrs[name]
        if win and vim.api.nvim_win_is_valid(win) then
            return win
        end
        local options = { split = split, win = anchor, noautocmd = true }
        options[split == "right" and "width" or "height"] = size
        win = vim.api.nvim_open_win(api.buf_nrs[name], false, options)
        api.win_nrs[name] = win
        vim.w[win].agency_bufnr = api.buf_nrs[name]
        local options = vim.tbl_extend(
            "force",
            {
                number = false,
                relativenumber = false,
                signcolumn = "no",
                statuscolumn = "",
                wrap = true,
                linebreak = true,
                winfixheight = true,
                foldcolumn = "0",
                spell = false,
                list = false,
                colorcolumn = "",
            },
            (config.windows[name] or {}).win_opts or {}
        )
        for key, value in pairs(options) do
            vim.wo[win][0][key] = value
        end
        if name == "chat" then
            require("agentic.ui.tool_call_fold").setup_window(win, api.buf_nrs.chat)
        end
        api.render_header(name)
        return win
    end
    function api.is_open()
        return not destroyed and api.win_nrs.chat ~= nil and vim.api.nvim_win_is_valid(api.win_nrs.chat)
    end
    function api.render_header(name, text)
        if text then
            api.headers[name] = text:gsub("[\r\n]", " "):gsub("%%", "%%%%")
        end
        local win = api.win_nrs[name]
        if win and vim.api.nvim_win_is_valid(win) then
            vim.wo[win][0].winbar = "Agency " .. name .. (api.headers[name] and " · " .. api.headers[name] or "")
        end
    end
    function api.show(opts)
        if destroyed or not vim.api.nvim_tabpage_is_valid(tab) then
            return false
        end
        local anchor = editor_window() or vim.api.nvim_tabpage_get_win(tab)
        local height = require("agentic.ui.widget_layout").calculate_height(config.windows.height)
        local chat = open("chat", anchor, "below", height)
        local width = vim.api.nvim_win_get_width(chat)
        local stack =
            open("input", chat, "right", math.max(1, math.floor(width * (config.windows.stack_width_ratio or 0.4))))
        for _, name in ipairs({ "code", "files", "diagnostics", "todos" }) do
            if not helpers.is_buffer_empty(api.buf_nrs[name]) then
                stack = open(
                    name,
                    stack,
                    "below",
                    math.min(
                        (config.windows[name] or {}).max_height or 10,
                        vim.api.nvim_buf_line_count(api.buf_nrs[name]) + 2
                    )
                )
            end
        end
        if opts and opts.focus_prompt and vim.api.nvim_get_current_tabpage() == tab then
            vim.api.nvim_set_current_win(api.win_nrs.input)
        end
        return true
    end
    function api.close_optional_window(name)
        local win = api.win_nrs[name]
        api.win_nrs[name] = nil
        if win and vim.api.nvim_win_is_valid(win) then
            closing = true
            pcall(vim.api.nvim_win_close, win, true)
            closing = false
        end
    end
    function api.hide()
        if closing then
            return
        end
        closing = true
        local wins = api.win_nrs
        api.win_nrs = {}
        for _, win in pairs(wins) do
            if vim.api.nvim_win_is_valid(win) and vim.tbl_contains(vim.api.nvim_list_tabpages(), tab) then
                pcall(vim.api.nvim_win_close, win, true)
            end
        end
        closing = false
        if api.on_hide then
            api.on_hide()
        end
    end
    function api.move_cursor_to(win)
        if
            win
            and vim.api.nvim_win_is_valid(win)
            and vim.api.nvim_win_get_tabpage(win) == vim.api.nvim_get_current_tabpage()
        then
            vim.api.nvim_set_current_win(win)
        end
    end
    function api.destroy()
        if destroyed then
            return
        end
        destroyed = true
        pcall(vim.api.nvim_del_augroup_by_id, api.augroup)
        api.hide()
        for _, buf in pairs(api.buf_nrs) do
            if vim.api.nvim_buf_is_valid(buf) then
                pcall(vim.api.nvim_buf_delete, buf, { force = true })
            end
        end
        if api.on_destroy then
            api.on_destroy()
        end
    end
    vim.api.nvim_create_autocmd("BufEnter", {
        group = api.augroup,
        callback = function()
            local win = vim.api.nvim_get_current_win()
            local expected = vim.w[win].agency_bufnr
            if
                destroyed
                or closing
                or not expected
                or not vim.api.nvim_buf_is_valid(expected)
                or vim.b[expected].agency_view ~= api.identity
            then
                return
            end
            local foreign = vim.api.nvim_win_get_buf(win)
            if foreign == expected or not vim.api.nvim_buf_is_valid(expected) then
                return
            end
            local target = editor_window()
            if not target then
                return
            end
            vim.api.nvim_win_set_buf(win, expected)
            vim.api.nvim_win_set_buf(target, foreign)
            vim.schedule(function()
                if not destroyed and vim.api.nvim_win_is_valid(target) then
                    vim.api.nvim_set_current_win(target)
                end
            end)
        end,
    })
    vim.api.nvim_create_autocmd("WinClosed", {
        group = api.augroup,
        callback = function(event)
            if closing or destroyed then
                return
            end
            for name, win in pairs(api.win_nrs) do
                if win == tonumber(event.match) then
                    api.win_nrs[name] = nil
                    if name == "chat" or name == "input" then
                        vim.schedule(function()
                            if not destroyed then
                                api.hide()
                            end
                        end)
                    end
                    return
                end
            end
        end,
    })
    vim.api.nvim_create_autocmd("TabClosed", {
        group = api.augroup,
        callback = function()
            if not vim.tbl_contains(vim.api.nvim_list_tabpages(), tab) then
                api.destroy()
            end
        end,
    })
    vim.api.nvim_create_autocmd("BufWipeout", {
        group = api.augroup,
        callback = function(event)
            if not destroyed and vim.tbl_contains(vim.tbl_values(api.buf_nrs), event.buf) then
                vim.schedule(function()
                    if not destroyed then
                        api.destroy()
                    end
                end)
            end
        end,
    })
    vim.api.nvim_create_autocmd("VimResized", {
        group = api.augroup,
        callback = function()
            if api.is_open() then
                pcall(
                    vim.api.nvim_win_set_height,
                    api.win_nrs.chat,
                    require("agentic.ui.widget_layout").calculate_height(config.windows.height)
                )
            end
        end,
    })
    return api
end

return M