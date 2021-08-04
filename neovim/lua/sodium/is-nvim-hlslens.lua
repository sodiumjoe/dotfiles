local utils = require("sodium.utils")

vim.o.hlsearch = true

utils.map({
	{ "n", "n", "<Plug>(is-n)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<CR>" },
	{ "n", "N", "<Plug>(is-N)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<CR>" },
	{ "n", "*", "<Plug>(is-*)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<CR>" },
	{ "n", "#", "<Plug>(is-#)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<CR>" },
	{ "n", "g*", "<Plug>(is-g*)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<CR>" },
	{ "n", "g#", "<Plug>(is-g#)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<CR>" },
})
