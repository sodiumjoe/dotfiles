local telescope = require("telescope")
local utils = require("sodium.utils")

telescope.setup({
	defaults = {
		prompt_prefix = "❯ ",
		selection_caret = "➤ ",
		vimgrep_arguments = {
			"rg",
			"--vimgrep",
			"--no-heading",
			"--smart-case",
		},
	},
})

telescope.load_extension("fzy_native")

utils.map({
	{ "n", [[<C-p>]], [[<cmd>Telescope find_files hidden=true<cr>]] },
	-- https://github.com/nvim-telescope/telescope.nvim/issues/750
	-- { "n", [[<leader>s]], [[<cmd>Telescope buffers show_all_buffers=true sort_lastused=true initial_mode=normal<cr>]] },
	{
		"n",
		[[<leader>s]],
		[[:lua require'telescope.builtin'.buffers{ on_complete = { function() vim.cmd"stopinsert" end } }<cr>]],
	},
	{ "n", [[<leader>8]], [[<cmd>Telescope grep_string<cr><esc>]] },
	{ "n", [[<leader>/]], [[<cmd>Telescope live_grep<cr>]] },
	{ "n", [[<leader>/]], [[:lua require('telescope.builtin').grep_string{ search = vim.fn.input('❯ ' ) }<cr>]] },
	-- { "n", [[<leader><Space>/]], [[<cmd>Telescope live_grep cwd=%:h<cr>]] },
	{ "n", [[<leader>d]], [[:lua require('telescope.builtin').find_files({search_dirs={'%:h'}})<cr>]] },
	{ "n", [[<leader><C-r>]], [[<cmd>Telescope registers<CR>]] },
	{ "n", [[<leader>g]], [[<cmd>Telescope git_status<cr><esc>]] },
})
