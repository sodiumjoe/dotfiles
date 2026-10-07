local M = {}

local function restored_panel(buf, headers)
    if vim.bo[buf].buftype ~= "" or vim.bo[buf].filetype ~= "" or vim.bo[buf].modified
        or vim.api.nvim_buf_line_count(buf) ~= 1 or vim.api.nvim_buf_get_lines(buf, 0, 1, false)[1] ~= "" then
        return false
    end
    local path = vim.api.nvim_buf_get_name(buf)
    if path == "" or vim.uv.fs_stat(path) then return false end
    local name = vim.fn.fnamemodify(path, ":t")
    for _, header in pairs(headers) do
        local title = header.title
        if type(title) == "string" and title ~= "" and name:sub(1, #title) == title then
            local suffix = name:sub(#title + 1)
            if suffix == "" or suffix:sub(1, 3) == " | " or suffix:match("^ %(Tab %d+%)")
                or suffix:match("^%-old%-%d+$") then return true end
        end
    end
    return false
end

function M.cleanup(tab)
    tab = tab or vim.api.nvim_get_current_tabpage()
    local headers = require("agentic.ui.window_decoration").get_headers_state(tab)
    local windows, stale, widths = {}, {}, {}
    for _, win in ipairs(vim.api.nvim_tabpage_list_wins(tab)) do
        if vim.api.nvim_win_get_config(win).relative == "" then
            windows[#windows + 1] = win
            if restored_panel(vim.api.nvim_win_get_buf(win), headers) then stale[#stale + 1] = win
            else widths[win] = vim.api.nvim_win_get_width(win) end
        end
    end
    if #stale == 0 then return {} end
    if #stale == #windows then
        local win = table.remove(stale, 1)
        local buf = vim.api.nvim_win_get_buf(win)
        vim.api.nvim_win_set_buf(win, vim.api.nvim_create_buf(true, false))
        vim.bo[buf].buflisted = false
    end
    local current = vim.api.nvim_get_current_win()
    for _, win in ipairs(stale) do
        local buf = vim.api.nvim_win_get_buf(win)
        vim.api.nvim_win_close(win, false)
        vim.bo[buf].buflisted = false
    end
    for _, win in ipairs(windows) do
        if widths[win] and vim.api.nvim_win_is_valid(win) and vim.api.nvim_win_get_width(win) ~= widths[win] then
            vim.api.nvim_win_set_width(win, widths[win])
        end
    end
    if vim.api.nvim_win_is_valid(current) then vim.api.nvim_set_current_win(current) end
    return stale
end

function M.setup()
    vim.api.nvim_create_autocmd("SessionLoadPost", {
        group = vim.api.nvim_create_augroup("AgencyRestoredWindows", { clear = true }),
        callback = function()
            for _, tab in ipairs(vim.api.nvim_list_tabpages()) do M.cleanup(tab) end
        end,
    })
end

return M