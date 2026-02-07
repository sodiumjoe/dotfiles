local utils = require("sodium.utils")

local g = vim.go
local o = vim.o
local w = vim.wo

g.mouse = ""
o.number = true
o.cursorline = true
o.undofile = true
o.splitbelow = true
o.splitright = true
o.joinspaces = false
o.clipboard = [[unnamedplus]]
o.shortmess = [[aoOtI]]
o.completeopt = [[menu,menuone,noselect,preview]]
o.modeline = false

o.infercase = true
o.smartcase = true
o.ignorecase = true
o.inccommand = [[split]]

if utils.is_executable("rg") then
    o.grepprg = [[rg --vimgrep --no-heading -S]]
    o.grepformat = [[%f:%l:%c:%m,%f:%l:%m]]
end

o.showtabline = 0
o.smartindent = true
o.tabstop = 2
o.shiftwidth = 2
o.expandtab = true
o.scrolloff = 5
g.showmode = false
g.diffopt = [[filler,vertical,algorithm:patience]]
o.guicursor = [[n-v-sm:block-Cursor,i-c-ci-ve:ver25,r-cr-o:hor20]]
o.signcolumn = [[number]]
w.breakindent = true
g.fillchars = [[vert:│,eob:⌁]]
g.splitkeep = "screen"
o.winborder = "rounded"

vim.cmd("syntax off")

vim.g.loaded_perl_provider = 0
