local utils = require("sodium.utils")

local opts = { noremap = true, silent = true }

utils.map({
	{ "n", "<leader>ew", ":HopWord<cr>", opts },
	{ "n", "<leader>e/", ":HopPattern<cr>", opts },
})
