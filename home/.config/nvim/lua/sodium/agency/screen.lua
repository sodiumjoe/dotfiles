local M = {}
local mru
local EXCLUDED_BUFTYPES = { quickfix = true, help = true, terminal = true }
local EXCLUDED_FILETYPES = {}
for _, filetype in ipairs({
    "neo-tree", "NvimTree", "oil", "qf", "help", "man", "terminal", "TelescopePrompt", "DiffviewFiles", "DiffviewFileHistory",
    "fugitive", "fugitiveblame", "gitcommit", "dashboard", "alpha", "starter", "notify", "noice", "aerial", "Outline",
    "trouble", "spectre_panel", "lazy", "mason",
}) do
    EXCLUDED_FILETYPES[filetype] = true
end

local function widget_win(win)
    return vim.w[win].agentic_bufnr ~= nil
end
local function split_win(win)
    return vim.api.nvim_win_get_config(win).relative == "" and not widget_win(win)
end
local function tabpage(tab)
    return (tab == nil or tab == 0) and vim.api.nvim_get_current_tabpage() or tab
end
local function half()
    return math.floor(vim.o.lines * 0.5)
end

local function documents(tab)
    local out = {}
    for _, win in ipairs(vim.api.nvim_tabpage_list_wins(tabpage(tab))) do
        if split_win(win) then
            out[#out + 1] = win
        end
    end
    return out
end
M.documents = documents

local function target(win)
    if not vim.api.nvim_win_is_valid(win) or not split_win(win) or vim.wo[win][0].winfixbuf then
        return false
    end
    local buf = vim.api.nvim_win_get_buf(win)
    local filetype = vim.bo[buf].filetype
    return not EXCLUDED_BUFTYPES[vim.bo[buf].buftype]
        and not EXCLUDED_FILETYPES[filetype]
        and not filetype:match("^Agentic")
end

function M.manager()
    local Registry = package.loaded["agentic.session_registry"]
    local manager = Registry and Registry.current()
    if manager and require("sodium.agency.rebind").agency(manager) then
        return manager
    end
end

local function follows(win)
    return win ~= nil and vim.api.nvim_win_is_valid(win)
        and vim.api.nvim_win_get_cursor(win)[1] == vim.api.nvim_buf_line_count(vim.api.nvim_win_get_buf(win))
end

local function keep_end(fn)
    local manager = M.manager()
    local chat = manager and manager.widget.win_nrs.chat
    local follow = follows(chat)
    local result = fn()
    if follow and vim.api.nvim_win_is_valid(chat) then
        vim.api.nvim_win_call(chat, function() vim.cmd("noautocmd normal! Gzb") end)
    end
    return result
end

local function release(tab)
    for _, win in ipairs(vim.api.nvim_tabpage_list_wins(tabpage(tab))) do
        if vim.w[win].agency_held then
            vim.wo[win][0].winfixheight = false
            vim.w[win].agency_held = nil
        end
    end
end

function M.state(tab)
    tab = tabpage(tab)
    local manager, state = M.manager(), "split"
    if not manager then
        state = "none"
    elseif manager.widget:get_visible_tab_id() ~= tab then
        state = "document"
    elseif #documents(tab) == 0 then
        state = "conversation"
    end
    if state ~= "split" then
        release(tab)
    end
    return state
end

function M.document_window(tab)
    tab = tabpage(tab)
    local number = vim.api.nvim_tabpage_get_number(tab)
    for _, win in ipairs({
        vim.api.nvim_tabpage_get_win(tab),
        vim.fn.win_getid(vim.fn.tabpagewinnr(number, "#"), number),
    }) do
        if win ~= 0 and target(win) then
            return win
        end
    end
    for _, win in ipairs(documents(tab)) do
        if target(win) then
            return win
        end
    end
end

local function hold(win)
    if win and M.state() == "split" then
        vim.wo[win][0].winfixheight = true
        vim.w[win].agency_held = true
    end
    return win
end

local function document_buffer()
    if mru and vim.api.nvim_buf_is_valid(mru) and vim.bo[mru].buflisted then
        return mru
    end
    local infos = vim.fn.getbufinfo({ buflisted = 1 })
    table.sort(infos, function(a, b)
        return a.lastused > b.lastused
    end)
    for _, info in ipairs(infos) do
        if info.name ~= "" and vim.bo[info.bufnr].buftype == "" then
            return info.bufnr
        end
    end
    local buf = vim.api.nvim_create_buf(false, true)
    vim.bo[buf].bufhidden = "wipe"
    return buf
end

function M.ensure_document(buf)
    local win = M.document_window()
    if win then
        return hold(win)
    end
    local manager = M.manager()
    local visible = manager and manager.widget:get_visible_tab_id() == vim.api.nvim_get_current_tabpage()
    return keep_end(function()
        return hold(vim.api.nvim_open_win(
            buf or document_buffer(),
            false,
            { split = "above", win = -1, height = visible and half() or nil }
        ))
    end)
end

function M.focus_document()
    local win = M.ensure_document()
    vim.api.nvim_set_current_win(win)
    return win
end

local function resize()
    local win = M.document_window() or documents()[1]
    local pos, width = vim.fn.win_screenpos(win), vim.api.nvim_win_get_width(win)
    local top, stack, starts = vim.fn.win_screenpos(M.manager().widget.win_nrs.chat)[1], {}, {}
    for _, other in ipairs(documents()) do
        local at, span = vim.fn.win_screenpos(other), vim.api.nvim_win_get_width(other)
        if other == win or vim.w[other].agency_held or target(other) then
            vim.wo[other][0].winfixheight = false
            vim.w[other].agency_held = nil
        end
        if other == win or at[1] < top and at[2] < pos[2] + width and pos[2] < at[2] + span then
            stack[#stack + 1], starts[at[1]] = other, true
        end
    end
    table.sort(stack, function(a, b)
        return vim.fn.win_screenpos(a)[1] < vim.fn.win_screenpos(b)[1]
    end)
    local count = vim.tbl_count(starts)
    for _, other in ipairs(stack) do
        vim.api.nvim_win_call(other, function()
            local view = vim.fn.winsaveview()
            vim.api.nvim_win_set_height(other, math.max(1, math.floor((half() - count + 1) / count)))
            vim.fn.winrestview(view)
        end)
    end
    hold(win)
end

function M.resize()
    if M.state() ~= "split" then
        return
    end
    keep_end(resize)
end

function M.fill()
    local manager = M.manager()
    local win = manager and manager.widget.win_nrs.chat
    if not win or not vim.api.nvim_win_is_valid(win) then return end
    vim.api.nvim_win_call(win, function()
        if vim.fn.line("w$") < vim.fn.line("$")
            or vim.api.nvim_win_text_height(win, { start_row = vim.fn.line("w0") - 1 }).all >= vim.api.nvim_win_get_height(win) then
            return
        end
        local view = vim.fn.winsaveview()
        vim.cmd("noautocmd normal! Gzb")
        view.topline, view.topfill = vim.fn.line("w0"), 0
        vim.fn.winrestview(view)
    end)
end

function M.track()
    local manager = M.manager()
    local win = manager and manager.widget.win_nrs.chat
    if not win or not vim.api.nvim_win_is_valid(win) then return end
    local height, last = vim.api.nvim_win_get_height(win), vim.api.nvim_buf_line_count(vim.api.nvim_win_get_buf(win))
    local state = vim.w[win].agency_view
    if state and state.height ~= height and state.at_end and vim.fn.line("w$", win) < last then
        vim.api.nvim_win_call(win, function() vim.cmd("noautocmd normal! Gzb") end)
    end
    vim.w[win].agency_view = { height = height, at_end = vim.fn.line("w$", win) >= last }
end

local function empty(win)
    local buf = vim.api.nvim_win_get_buf(win)
    return vim.bo[buf].buftype == "" and vim.api.nvim_buf_get_name(buf) == "" and not vim.bo[buf].modified
        and vim.api.nvim_buf_line_count(buf) == 1 and vim.api.nvim_buf_get_lines(buf, 0, 1, false)[1] == ""
end

function M.close_empty()
    local manager, wins = M.manager(), documents()
    if not manager or manager.widget:get_visible_tab_id() ~= vim.api.nvim_get_current_tabpage() or #wins == 0
        or #vim.tbl_filter(empty, wins) ~= #wins then
        return
    end
    keep_end(function() for _, win in ipairs(wins) do
        local buf = vim.api.nvim_win_get_buf(win)
        if pcall(vim.api.nvim_win_close, win, false) and vim.api.nvim_buf_is_valid(buf) and #vim.fn.win_findbuf(buf) == 0
            and vim.api.nvim_buf_get_name(buf) == "" and not vim.bo[buf].modified and vim.api.nvim_buf_line_count(buf) == 1
            and vim.api.nvim_buf_get_lines(buf, 0, 1, false)[1] == "" then
            pcall(vim.api.nvim_buf_delete, buf, { force = true })
        end
    end end)
end

local function placed(win)
    local manager, tab = M.manager(), vim.api.nvim_get_current_tabpage()
    if not manager or manager.widget:get_visible_tab_id() ~= tab or not vim.api.nvim_win_is_valid(win)
        or vim.api.nvim_win_get_tabpage(win) ~= tab or not split_win(win) then
        return
    end
    local chat = manager.widget.win_nrs.chat
    if chat and vim.api.nvim_win_is_valid(chat) and vim.fn.win_screenpos(win)[1] >= vim.fn.win_screenpos(chat)[1] then
        pcall(vim.api.nvim_win_call, win, function() vim.cmd("wincmd K") end)
    end
    M.resize()
end

local function close_documents()
    keep_end(function()
        for _, win in ipairs(documents()) do
            pcall(vim.api.nvim_win_close, win, true)
        end
    end)
end

function M.cycle()
    local state, manager = M.state(), M.manager()
    if state == "conversation" then
        M.focus_document()
    elseif state == "split" then
        manager.widget:hide()
        release()
    elseif state == "document" then
        local elsewhere = manager.widget:is_open()
        require("agentic.session_registry").show_session(manager.session_key)
        if elsewhere then
            M.resize()
        elseif manager.widget:get_visible_tab_id() == vim.api.nvim_get_current_tabpage() then
            close_documents()
        end
    end
end

function M.conversation(manager)
    local state = M.state()
    if M.manager() ~= manager then return end
    if state == "split" then
        close_documents()
        release()
    elseif state == "document" then
        require("agentic.session_registry").show_session(manager.session_key)
        if manager.widget:get_visible_tab_id() == vim.api.nvim_get_current_tabpage() then close_documents() end
    end
end

function M.setup()
    local group = vim.api.nvim_create_augroup("AgencyScreen", { clear = true })
    vim.api.nvim_create_autocmd("VimResized", {
        group = group,
        callback = function()
            M.resize()
            M.fill()
            M.track()
        end,
    })
    vim.api.nvim_create_autocmd({ "WinScrolled", "WinResized" }, {
        group = group,
        callback = function()
            M.track()
        end,
    })
    vim.api.nvim_create_autocmd("WinNew", {
        group = group,
        callback = function()
            local win = vim.api.nvim_get_current_win()
            vim.schedule(function() placed(win) end)
        end,
    })
    vim.api.nvim_create_autocmd("BufEnter", {
        group = group,
        callback = function(args)
            local win = vim.api.nvim_get_current_win()
            if
                split_win(win)
                and vim.bo[args.buf].buftype == ""
                and vim.bo[args.buf].buflisted
                and vim.api.nvim_buf_get_name(args.buf) ~= ""
            then
                mru = args.buf
            end
        end,
    })
end

return M
