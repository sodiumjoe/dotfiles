require("compe").setup({
	enable = true,
	autocomplete = true,
	debug = false,
	min_length = 1,
	source = {
		path = true,
		buffer = true,
		calc = true,
		nvim_lsp = true,
		nvim_lua = true,
		treesitter = true,
	},
})
