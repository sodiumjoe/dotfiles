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
local diff_highlights = require("sodium.diff_highlights")

local function set_diff_highlights()
    diff_highlights.apply_diff_mode(p)
end

local function restore_diff_highlights()
    diff_highlights.restore(p, git)
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
