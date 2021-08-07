local utils = require("sodium.utils")
local g = vim.g
local o = vim.o
local w = vim.wo

o.undofile = true
o.splitbelow = true
o.splitright = true
-- Insert only one space when joining lines that contain sentence-terminating
-- punctuation like `.`.
o.joinspaces = false
o.clipboard = [[unnamedplus]]
-- don't show intro message
o.shortmess = [[aoOtI]]
o.completeopt = [[menuone,noselect]]
o.modeline = false

o.infercase = true
o.smartcase = true
o.ignorecase = true
o.inccommand = [[split]]

if vim.fn.executable("rg") then
	o.grepprg = [[rg --vimgrep --no-heading -S]]
	o.grepformat = [[%f:%l:%c:%m,%f:%l:%m]]
end

-- display
-- =======
o.guifont = [[Inconsolata:h16]]
o.background = [[dark]]
vim.cmd([[colorscheme sodium]])
-- folding column width
w.foldcolumn = [[0]]
o.showtabline = 0
o.autoindent = true
o.smartindent = true
o.tabstop = 2
o.shiftwidth = 2
o.expandtab = true
o.scrolloff = 5
g.showmode = false
g.diffopt = [[filler,vertical]]
g.guicursor = [[n-v-sm:block,i-c-ci-ve:ver25,r-cr-o:hor20]]
w.signcolumn = [[yes]]
w.breakindent = true
g.fillchars = [[vert:\│,eob:⌁]]

-- misc
-- ====
utils.augroup("AutoCloseQFLL", { "FileType qf nnoremap <silent> <buffer> <CR> <CR>:cclose<CR>:lclose<CR>" })

utils.augroup("RestoreCursorPos", {
	[[BufReadPost * if line("'\"") > 1 && line("'\"") <= line("$") && &ft !~# 'commit' |   exe "normal! g`\"" | endif]],
})

-- javascript source resolution
g.path = "."
o.suffixesadd = ".js"

vim.api.nvim_exec(
	[[
  function! LoadMainNodeModule(fname)
    let nodeModules = "./node_modules/"
    let packageJsonPath = nodeModules . a:fname . "/package.json"

    if filereadable(packageJsonPath)
      return nodeModules . a:fname . "/" . json_decode(join(readfile(packageJsonPath))).main
    else
      return nodeModules . a:fname
    endif
  endfunction

  set includeexpr=LoadMainNodeModule(v:fname)
]],
	false
)

utils.map({
	-- copy relative path to clipboard
	{ "n", [[<leader>cr]], [[:let @+ = expand("%")<cr>]], { silent = true } },
	-- copy full path to clipboard
	{ "n", [[<leader>cf]], [[:let @+ = expand("%:p")<cr>]], { silent = true } },
	-- leader d and leader p for deleting instead of cutting and pasting
	{ "n", [[<leader>d]], [["_d]], { noremap = true } },
	{ "x", [[<leader>d]], [["_d]], { noremap = true } },
	{ "x", [[<leader>p]], [["_dP]], { noremap = true } },

	-- movement
	{ "n", "j", "gj", { noremap = true } },
	{ "n", "k", "gk", { noremap = true } },

	-- search visual selection (busted)
	-- { "v", [[//]], [[y/<C-R>"<CR>]], { noremap = true } },
})
