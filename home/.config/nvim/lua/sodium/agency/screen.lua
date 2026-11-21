local M = {}
local mru
local Registry = function()
    return require("agentic.session_registry")
end
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

function M.manager(tab)
    tab = tabpage(tab)
    local Rebind, manager = require("sodium.agency.rebind"), nil
    for _, session in pairs(Registry().sessions) do
        if session.widget:get_visible_tab_id() == tab then
            manager = session
        end
    end
    manager = manager or Registry().current()
    if Rebind.agency(manager) then
        return manager
    end
end

function M.state(tab)
    tab = tabpage(tab)
    local manager = M.manager(tab)
    if not manager then
        return "none"
    end
    if manager.widget:get_visible_tab_id() ~= tab then
        return "document"
    end
    return #documents(tab) > 0 and "split" or "conversation"
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
    return vim.api.nvim_create_buf(false, true)
end

function M.ensure_document(buf)
    local win = M.document_window()
    if win then
        return hold(win)
    end
    local manager = M.manager()
    local visible = manager and manager.widget:get_visible_tab_id() == vim.api.nvim_get_current_tabpage()
    win = vim.api.nvim_open_win(
        buf or document_buffer(),
        false,
        { split = "above", win = -1, height = visible and half() or nil }
    )
    if visible then
        vim.wo[win][0].winfixheight = true
    end
    return win
end

function M.resize()
    if M.state() ~= "split" then
        return
    end
    local win = M.document_window() or documents()[1]
    vim.api.nvim_win_set_height(win, half())
    hold(win)
end

function M.cycle()
    local state, manager = M.state(), M.manager()
    if state == "conversation" then
        vim.api.nvim_set_current_win(M.ensure_document())
    elseif state == "split" then
        manager.widget:hide()
        for _, win in ipairs(documents()) do
            vim.wo[win][0].winfixheight = false
        end
    elseif state == "document" then
        Registry().show_session(manager.session_key)
        if manager.widget:get_visible_tab_id() == vim.api.nvim_get_current_tabpage() then
            for _, win in ipairs(documents()) do
                pcall(vim.api.nvim_win_close, win, true)
            end
        end
    end
end

function M.setup()
    vim.api.nvim_create_autocmd("BufEnter", {
        group = vim.api.nvim_create_augroup("AgencyScreen", { clear = true }),
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
