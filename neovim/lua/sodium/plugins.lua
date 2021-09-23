local utils = require("sodium.utils")
local opts = { noremap = true, silent = true }
local g = vim.g

-- vim-plug
-- ========
vim.fn["plug#begin"]("~/.config/nvim/plugged")

vim.fn["plug#"]("nvim-lua/plenary.nvim")
vim.fn["plug#"]("benizi/vim-automkdir")
vim.fn["plug#"]("christoomey/vim-tmux-navigator")
vim.fn["plug#"]("editorconfig/editorconfig-vim")
vim.fn["plug#"]("haya14busa/is.vim")
vim.fn["plug#"]("hrsh7th/cmp-nvim-lsp")
vim.fn["plug#"]("hrsh7th/cmp-buffer")
vim.fn["plug#"]("hrsh7th/nvim-cmp")
vim.fn["plug#"]("hrsh7th/vim-vsnip")
vim.fn["plug#"]("justinmk/vim-dirvish")
vim.fn["plug#"]("kevinhwang91/nvim-hlslens")
vim.fn["plug#"]("kyazdani42/nvim-web-devicons")
vim.fn["plug#"]("lewis6991/gitsigns.nvim")
vim.fn["plug#"]("matze/vim-move")
vim.fn["plug#"]("mfussenegger/nvim-lint")
vim.fn["plug#"]("neovim/nvim-lspconfig")
vim.fn["plug#"]("nvim-lua/lsp-status.nvim")
vim.fn["plug#"]("nvim-lua/popup.nvim")
vim.fn["plug#"]("nvim-telescope/telescope.nvim")
vim.fn["plug#"]("nvim-telescope/telescope-fzf-native.nvim", { ["do"] = "make" })
vim.fn["plug#"]("nvim-treesitter/nvim-treesitter", { branch = "0.5-compat", ["do"] = ":TSUpdate" })
vim.fn["plug#"]("ikatyang/tree-sitter-markdown")
vim.fn["plug#"]("norcalli/nvim-colorizer.lua")
vim.fn["plug#"]("onsails/lspkind-nvim")
vim.fn["plug#"]("ntpeters/vim-better-whitespace")
vim.fn["plug#"]("phaazon/hop.nvim")
vim.fn["plug#"]("rhysd/conflict-marker.vim")
vim.fn["plug#"]("sbdchd/neoformat")
vim.fn["plug#"]("sodiumjoe/nvim-highlite")
vim.fn["plug#"]("tpope/vim-commentary")
vim.fn["plug#"]("tpope/vim-eunuch")
vim.fn["plug#"]("tpope/vim-fugitive")
vim.fn["plug#"]("tpope/vim-repeat")
vim.fn["plug#"]("tpope/vim-surround")
vim.fn["plug#"]("vimwiki/vimwiki")
vim.fn["plug#"]("whatyouhide/vim-lengthmatters")

vim.fn["plug#end"]()

g.popup_opts = { focusable = false, border = "rounded" }

-- colorizer
-- =========
require("colorizer").setup()

-- gitsigns
-- ========
require("gitsigns").setup()

-- cmp
-- ===
local cmp = require("cmp")
cmp.setup({
	completion = {
		autocomplete = true,
	},
	documentation = g.popup_opts,
	mapping = {
		["<cr>"] = cmp.mapping.confirm({ select = true }),
	},
	sources = {
		{ name = "nvim_lsp" },
		{ name = "buffer" },
	},
	snippet = {
		expand = function(args)
			vim.fn["vsnip#anonymous"](args.body)
		end,
	},
	formatting = {
		format = function(entry, vim_item)
			-- fancy icons and a name of kind
			vim_item.kind = require("lspkind").presets.default[vim_item.kind] .. " " .. vim_item.kind

			-- set a name for each source
			vim_item.menu = ({
				buffer = "[Buffer]",
				nvim_lsp = "[LSP]",
			})[entry.source.name]
			return vim_item
		end,
	},
})

-- nvim-web-devicons
-- =================
require("nvim-web-devicons").setup({
	default = true,
})

-- dirvish
-- =======
utils.augroup("DirvishConfig", {
	"FileType dirvish silent! unmap <buffer> <C-p>",
	"FileType dirvish silent! unmap <buffer> <C-n>",
})

-- editorconfig
-- ============
g.EditorConfig_exclude_patterns = { "fugitive://.*" }

-- hlslens
-- =======
require("hlslens").setup({
	calm_down = true,
	nearest_only = false,
})

vim.o.hlsearch = true

utils.map({
	{ "n", "n", "<Plug>(is-n)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<cr>" },
	{ "n", "N", "<Plug>(is-N)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<cr>" },
	{ "n", "*", "<Plug>(is-*)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<cr>" },
	{ "n", "#", "<Plug>(is-#)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<cr>" },
	{ "n", "g*", "<Plug>(is-g*)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<cr>" },
	{ "n", "g#", "<Plug>(is-g#)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<cr>" },
})

-- hop
-- ===
utils.map({
	{ "n", "<leader>ew", ":HopWord<cr>", opts },
	{ "n", "<leader>e/", ":HopPattern<cr>", opts },
})

-- vim-lengthmatters
-- =================
vim.cmd("call lengthmatters#highlight('ctermbg=0 guibg=#556873')")
g.lengthmatters_excluded = {
	"tagbar",
	"startify",
	"gundo",
	"vimshell",
	"w3m",
	"nerdtree",
	"help",
	"qf",
	"dirvish",
	"gitcommit",
	"json",
	"vimwiki",
	"javascript",
	"javascript.jsx",
	"lua",
}

-- lint
-- ====
local lint = require("lint")
local lint_parser = require("lint.parser")
lint.linters_by_ft = {
	javascript = { "eslint" },
	["javascript.jsx"] = { "eslint" },
	typescript = { "eslint" },
	typescriptreact = { "eslint" },
	lua = { "luacheck" },
}

local pattern = ".-:(%d+):(%d+):%s*(.*)%s*%[(.+)/(.+)%]"
local groups = { "line", "start_col", "message", "severity", "code" }
local severity_map = {
	Error = vim.lsp.protocol.DiagnosticSeverity.Error,
	Warning = vim.lsp.protocol.DiagnosticSeverity.Warning,
}
local parser_from_pattern = lint_parser.from_pattern(pattern, groups, severity_map, { source = "eslint" })
local function parser(output, bufnr)
	local diagnostics = parser_from_pattern(output, bufnr)
	vim.cmd([[checktime]])
	return diagnostics
end

lint.linters.eslint = {
	cmd = "npx",
	args = { "eslint", "--no-color", "--fix", "--format", "unix" },
	stream = "stdout",
	parser = parser,
	ignore_exitcode = true,
}

function _G.try_lint()
	if lint.linters_by_ft[vim.bo.filetype] then
		lint.try_lint()
	end
end

utils.augroup("TryLint", { "BufWritePost,InsertLeave,BufEnter * lua try_lint()" })

-- lspconfig
-- =========
local nvim_lsp = require("lspconfig")
local lsp_status = require("lsp-status")

vim.lsp.handlers["textDocument/hover"] = vim.lsp.with(vim.lsp.handlers.hover, g.popup_opts)
vim.lsp.handlers["textDocument/signatureHelp"] = vim.lsp.with(vim.lsp.handlers.signature_help, g.popup_opts)

function _G.toggle_quickfix()
	for _, win in pairs(vim.fn.getwininfo()) do
		if win.quickfix == 1 then
			vim.cmd("lclose")
			return
		end
	end
	vim.lsp.diagnostic.set_loclist()
end

local on_attach = function(client, bufnr)
	-- setup lsp-status
	lsp_status.on_attach(client, bufnr)
	require("lspkind").init({})
end

local servers = { "flow", "rust_analyzer", "tsserver" }

for _, lsp in ipairs(servers) do
	if nvim_lsp[lsp] then
		nvim_lsp[lsp].setup({
			on_attach = on_attach,
			flags = {
				debounce_text_changes = 150,
			},
		})
	end
end

nvim_lsp.sorbet.setup({
	cmd = { "pay", "exec", "scripts/bin/typecheck", "--lsp" },
	filetypes = { "ruby" },
})

vim.lsp.handlers["textDocument/publishDiagnostics"] = function(_, _, params, client_id, _)
	local config = {
		underline = true,
		virtual_text = {
			prefix = " 💩",
			spacing = 4,
		},
		signs = true,
		update_in_insert = false,
	}
	local uri = params.uri
	local bufnr = vim.uri_to_bufnr(uri)

	if not bufnr then
		return
	end

	local diagnostics = params.diagnostics

	for i, v in ipairs(diagnostics) do
		diagnostics[i].message = string.format("%s: %s [%s] ", v.source, v.message, v.code)
	end

	vim.lsp.diagnostic.save(diagnostics, bufnr, client_id)

	if not vim.api.nvim_buf_is_loaded(bufnr) then
		return
	end

	vim.lsp.diagnostic.display(diagnostics, bufnr, client_id, config)
end

for type, icon in pairs(utils.icons) do
	local hl = "LspDiagnosticsSign" .. type
	vim.fn.sign_define(hl, { text = icon, texthl = hl, numhl = "" })
end

-- See `:help vim.lsp.*` for documentation on any of the below functions
utils.map({
	{ "n", "gD", "<Cmd>lua vim.lsp.buf.declaration()<cr>", opts },
	{ "n", "gd", "<Cmd>lua vim.lsp.buf.definition()<cr>", opts },
	{ "n", "K", "<Cmd>lua vim.lsp.buf.hover()<cr>", opts },
	{ "n", "gi", "<cmd>lua vim.lsp.buf.implementation()<cr>", opts },
	{ "n", "<space>D", "<cmd>lua vim.lsp.buf.type_definition()<cr>", opts },
	-- { "n", "<space>rn", "<cmd>lua vim.lsp.buf.rename()<cr>", opts },
	{ "n", "<space>ca", "<cmd>lua vim.lsp.buf.code_action()<cr>", opts },
	{ "n", "gr", "<cmd>lua vim.lsp.buf.references()<cr>", opts },
	{
		"n",
		"<space>ee",
		"<cmd>lua vim.lsp.diagnostic.show_line_diagnostics(vim.g.popup_opts)<cr>",
		opts,
	},
	{
		"n",
		"<leader>p",
		-- disable moving into floating window when only one diagnostic: https://github.com/neovim/neovim/issues/15122
		"<cmd>lua vim.lsp.diagnostic.goto_prev({popup_opts=vim.g.popup_opts,severity_limit=4})<cr>",
		opts,
	},
	{
		"n",
		"<leader>n",
		"<cmd>lua vim.lsp.diagnostic.goto_next({popup_opts=vim.g.popup_opts,severity_limit=4})<cr>",
		opts,
	},
	{ "n", "<space>q", "<cmd>lua toggle_quickfix()<cr>", opts },
	{ "n", "<space>f", "<cmd>lua vim.lsp.buf.formatting()<cr>", opts },
})

-- neoformat
-- =========
utils.augroup("Autoformat", {
	"BufWritePre *.{js,ts,tsx,rs,go,lua} silent! Neoformat",
})

g.neoformat_try_node_exe = true

g.neoformat_enabled_javascript = { "prettier" }
g.neoformat_enabled_typescript = { "prettier" }
g.neoformat_enabled_typescriptreact = { "prettier" }

g.neoformat_typescriptreact_prettier = {
	exe = "npx",
	args = { "prettier", "--stdin", "--parser", "typescript" },
	stdin = 1,
}

g.neoformat_enabled_rust = { "rustfmt" }
g.neoformat_enabled_go = { "goimports", "gofmt" }
g.neoformat_enabled_lua = { "stylua" }

-- telescope
-- =========
local telescope = require("telescope")
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

telescope.load_extension("fzf")

utils.map({
	{ "n", [[<leader>r]], [[<cmd>Telescope resume initial_mode=normal<cr>]] },
	{ "n", [[<C-p>]], [[<cmd>Telescope find_files hidden=true<cr>]] },
	{
		"n",
		[[<leader>s]],
		[[<cmd>Telescope buffers show_all_buffers=true sort_mru=true ignore_current_buffer=true initial_mode=normal<cr>]],
	},
	{ "n", [[<leader>8]], [[<cmd>Telescope grep_string<cr><esc>]] },
	{ "n", [[<leader>/]], [[<cmd>Telescope live_grep<cr>]] },
	{ "n", [[<leader><Space>/]], [[<cmd>Telescope live_grep cwd=%:h<cr>]] },
	-- { "n", [[<leader>d]], [[:lua require('telescope.builtin').find_files({search_dirs={'%:h'}})<cr>]] },
	{ "n", [[<leader>d]], [[<cmd>Telescope find_files search_dirs=%:h<cr>]] },
	{ "n", [[<leader><C-r>]], [[<cmd>Telescope registers<cr>]] },
	{ "n", [[<leader>g]], [[<cmd>Telescope git_status use_git_root=false<cr><esc>]] },
})

-- vim-tmux-navigator
-- ==================
g.tmux_navigator_no_mappings = 1

utils.map({
	{ "n", "<C-w>h", ":TmuxNavigateLeft<cr>", opts },
	{ "n", "<C-w>j", ":TmuxNavigateDown<cr>", opts },
	{ "n", "<C-w>k", ":TmuxNavigateUp<cr>", opts },
	{ "n", "<C-w>l", ":TmuxNavigateRight<cr>", opts },
	{ "n", "<C-w>w", ":TmuxNavigatePrevious<cr>", opts },
})

-- nvim-treesitter
-- ===============
require("nvim-treesitter.configs").setup({
	ensure_installed = "maintained",
	highlight = {
		enable = true,
		disable = {},
	},
	indent = {
		enable = false,
	},
})

-- vim-better-whitespace
-- =====================
utils.augroup("DisableBetterWhitespace", { "Filetype diff,gitcommit,qf,help,markdown,javascript DisableWhitespace" })

-- vim-move
-- ========
g.move_key_modifier = "C"

-- vimwiki
-- =======
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
	"FileType vimwiki lua require('cmp').setup.buffer { enabled = false }",
})

-- tree-sitter-markdown
-- ====================
local parser_config = require("nvim-treesitter.parsers").get_parser_configs()
parser_config.markdown = {
	install_info = {
		url = "https://github.com/ikatyang/tree-sitter-markdown",
		files = { "src/parser.c", "src/scanner.cc" },
	},
	filetype = "markdown",
	used_by = "vimwiki",
}
parser_config.markdown.used_by = "vimwiki"
