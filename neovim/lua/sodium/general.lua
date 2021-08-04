local g = vim.g
local utils = require("sodium.utils")

-- faster startup time
-- :h g:python_host_prog
g.python_host_prog = "/usr/bin/python"
-- :h g:python3_host_prog
g.python3_host_prog = "$HOMEBREW_PREFIX/bin/python3"

g.mapleader = [[ ]]

local o = vim.o
local b = vim.bo
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

b.infercase = true
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
o.termguicolors = true
vim.cmd([[colorscheme sodium]])
-- folding column width
w.foldcolumn = [[0]]
o.showtabline = 0
b.autoindent = true
b.smartindent = true
b.tabstop = 2
b.shiftwidth = 2
b.expandtab = true
g.scrolloff = 5
g.showmode = false
g.diffopt = [[filler,vertical]]
g.guicursor = [[n-v-sm:block,i-c-ci-ve:ver25,r-cr-o:hor20]]
w.signcolumn = [[yes]]
w.breakindent = true
g.fillchars = [[vert:\│,eob:⌁]]

-- misc
-- ====

utils.augroup("AutoCloseQFLL", { "FileType qf nnoremap <silent> <buffer> <CR> <CR>:cclose<CR>:lclose<CR>" })

-- javascript source resolution
g.path = "."
b.suffixesadd = ".js"

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
