local utils = require("sodium.utils")

utils.augroup("AutoCloseQFLL", { clear = true })("FileType", {
    pattern = { "qf" },
    command = "nnoremap <silent> <buffer> <CR> <CR>:cclose<CR>:lclose<CR>",
})

utils.augroup("RestoreCursorPos", { clear = true })("BufReadPost", {
    pattern = "*",
    command = [[if line("'\"") > 1 && line("'\"") <= line("$") && &ft !~# 'commit' |   exe "normal! g`\"" | endif]],
})

utils.augroup("SilenceWorkSwap", { clear = true })("SwapExists", {
    pattern = vim.fn.expand("~/stripe/work") .. "/*",
    callback = function()
        vim.v.swapchoice = "e"
    end,
})

utils.augroup("AutoReloadExternalChanges", { clear = true })("FocusGained", {
    callback = function()
        vim.cmd("checktime")
    end,
})

-- Restyle diff highlights for readable vimdiff: syntax shows through,
-- diff status shown via colored gutter bar in statuscol instead.
local diff_au = utils.augroup("DiffModeHighlights", { clear = true })
local p = require("sodium.config.colorscheme").palette
local git = require("sodium.config.colorscheme").spec.git

local function set_diff_highlights()
    vim.api.nvim_set_hl(0, "DiffAdd", { bg = nil })
    vim.api.nvim_set_hl(0, "DiffChange", { bg = nil })
    vim.api.nvim_set_hl(0, "DiffDelete", { fg = p.bg2, bg = p.bg2 })
    vim.api.nvim_set_hl(0, "DiffText", { bg = p.bg2 })
end

local function restore_diff_highlights()
    vim.api.nvim_set_hl(0, "DiffAdd", { fg = p.bg1, bg = git.add })
    vim.api.nvim_set_hl(0, "DiffChange", { fg = p.bg1, bg = git.changed })
    vim.api.nvim_set_hl(0, "DiffDelete", { fg = p.bg1, bg = git.removed })
    vim.api.nvim_set_hl(0, "DiffText", { fg = p.bg1, bg = p.yellow })
end

local function update_diff_highlights()
    -- Check if any window is in diff mode
    for _, win in ipairs(vim.api.nvim_list_wins()) do
        if vim.wo[win].diff then
            set_diff_highlights()
            return
        end
    end
    restore_diff_highlights()
end

diff_au("OptionSet", {
    pattern = "diff",
    callback = update_diff_highlights,
})

diff_au("BufWinEnter", {
    callback = function()
        if vim.wo.diff then
            set_diff_highlights()
        end
    end,
})
