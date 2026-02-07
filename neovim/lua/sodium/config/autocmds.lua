local utils = require("sodium.utils")

utils.augroup("AutoCloseQFLL", { clear = true })("FileType", {
    pattern = { "qf" },
    command = "nnoremap <silent> <buffer> <CR> <CR>:cclose<CR>:lclose<CR>",
})

utils.augroup("RestoreCursorPos", { clear = true })("BufReadPost", {
    pattern = "*",
    command = [[if line("'\"") > 1 && line("'\"") <= line("$") && &ft !~# 'commit' |   exe "normal! g`\"" | endif]],
})
