local utils = require("sodium.utils")
local g = vim.g

local wiki = {
	path = "~/home/todo.wiki",
	syntax = "markdown",
}
local work_wiki = {
	path = "~/stripe/todo.wiki",
	path_html = "~/stripe/todo.html",
	syntax = "markdown",
}

g.vimwiki_list = { work_wiki, wiki }
g.vimwiki_auto_header = 1

utils.map({
	{ "n", "<leader>wp", "<Plug>VimwikiDiaryPrevDay" },
	{ "n", "<leader>=", "<Plug>VimwikiAddHeaderLevel" },
	{ "n", "<leader>-", "<Plug>VimwikiRemoveHeaderLevel" },
})

utils.augroup("Vimwiki", {
	"FileType vimwiki nmap <buffer> <leader>wn <Plug>VimwikiDiaryNextDay",
})
