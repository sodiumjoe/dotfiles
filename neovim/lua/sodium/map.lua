local utils = require("sodium.utils")

local mappings = {
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
}

utils.map(mappings)
