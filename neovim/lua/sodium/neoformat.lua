local utils = require("sodium.utils")
local g = vim.g

utils.augroup("Autoformat", {
	"BufWritePre *.{js,rs,go,lua} silent! Neoformat",
})

g.neoformat_enabled_javascript = { "prettier" }
g.neoformat_enabled_typescript = { "prettier" }
g.neoformat_javascript_prettier = {
	exe = "./node_modules/.bin/prettier",
	args = { "--stdin", "--stdin-filepath", '"%:p"' },
	stdin = 1,
}

g.neoformat_enabled_rust = { "rustfmt" }
g.neoformat_enabled_go = { "goimports", "gofmt" }
g.neoformat_enabled_lua = { "stylua" }
