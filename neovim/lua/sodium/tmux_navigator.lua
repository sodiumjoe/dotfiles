local utils = require("sodium.utils")

vim.g.tmux_navigator_no_mappings = 1

local opts = { noremap = true, silent = true }

utils.map({
	{ "n", "<C-w>h", ":TmuxNavigateLeft<cr>", opts },
	{ "n", "<C-w>j", ":TmuxNavigateDown<cr>", opts },
	{ "n", "<C-w>k", ":TmuxNavigateUp<cr>", opts },
	{ "n", "<C-w>l", ":TmuxNavigateRight<cr>", opts },
	{ "n", "<C-w>w", ":TmuxNavigatePrevious<cr>", opts },
})
