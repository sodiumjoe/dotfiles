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
vim.fn["plug#"]("justinmk/vim-dirvish")
vim.fn["plug#"]("kevinhwang91/nvim-hlslens")
vim.fn["plug#"]("kyazdani42/nvim-web-devicons")
vim.fn["plug#"]("lewis6991/gitsigns.nvim")
vim.fn["plug#"]("matze/vim-move")
vim.fn["plug#"]("mfussenegger/nvim-lint")
vim.fn["plug#"]("neovim/nvim-lspconfig")
vim.fn["plug#"]("nvim-lua/completion-nvim")
vim.fn["plug#"]("nvim-lua/lsp-status.nvim")
vim.fn["plug#"]("nvim-lua/popup.nvim")
vim.fn["plug#"]("nvim-telescope/telescope.nvim")
vim.fn["plug#"]("nvim-telescope/telescope-fzy-native.nvim")
vim.fn["plug#"]("nvim-treesitter/nvim-treesitter", { branch = "0.5-compat", ["do"] = ":TSUpdate" })
vim.fn["plug#"]("nvim-treesitter/completion-treesitter")
vim.fn["plug#"]("ikatyang/tree-sitter-markdown")
vim.fn["plug#"]("norcalli/nvim-colorizer.lua")
vim.fn["plug#"]("ntpeters/vim-better-whitespace")
vim.fn["plug#"]("phaazon/hop.nvim")
vim.fn["plug#"]("rhysd/conflict-marker.vim")
vim.fn["plug#"]("sbdchd/neoformat")
vim.fn["plug#"]("sodiumjoe/nvim-highlite")
vim.fn["plug#"]("steelsojka/completion-buffers")
vim.fn["plug#"]("tpope/vim-commentary")
vim.fn["plug#"]("tpope/vim-eunuch")
vim.fn["plug#"]("tpope/vim-fugitive")
vim.fn["plug#"]("tpope/vim-repeat")
vim.fn["plug#"]("tpope/vim-surround")
vim.fn["plug#"]("vimwiki/vimwiki")
vim.fn["plug#"]("whatyouhide/vim-lengthmatters")

vim.fn["plug#end"]()

-- colorizer
-- =========
require("colorizer").setup()

-- gitsigns
-- ========
require("gitsigns").setup()

-- completion-nvim
-- ===============

local completion = require("completion")

vim.g.completion_chain_complete_list = {
	default = {
		{ complete_items = { "lsp", "buffers", "ts" } },
		{ mode = { "<c-p>" } },
		{ mode = { "<c-n>" } },
	},
}

-- nvim-web-devicons
-- =================
require("nvim-web-devicons").setup({
	default = true,
})

-- dirvish
-- =======
utils.augroup("DirvishConfig", {
	"FileType dirvish silent! unmap <buffer> <C-p>",
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
	{ "n", "n", "<Plug>(is-n)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<CR>" },
	{ "n", "N", "<Plug>(is-N)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<CR>" },
	{ "n", "*", "<Plug>(is-*)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<CR>" },
	{ "n", "#", "<Plug>(is-#)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<CR>" },
	{ "n", "g*", "<Plug>(is-g*)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<CR>" },
	{ "n", "g#", "<Plug>(is-g#)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<CR>" },
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
}

-- lint
-- ====
local lint = require("lint")
lint.linters_by_ft = {
	javascript = { "eslint" },
	["javascript.jsx"] = { "eslint" },
	typescript = { "eslint" },
	typescriptreact = { "eslint" },
	lua = { "luacheck" },
}

local pattern = ".-:(%d+):(%d+):%s+(.*)(%[.*%])"
local groups = { "line", "start_col", "severity", "message" }
local pattern = '.-:(%d+):(%d+):%s*(.*)%s*%[(.+)/(.+)%]'
local groups = { 'line', 'start_col', 'message', 'severity', 'code' }
local severity_map = {
  Error = vim.lsp.protocol.DiagnosticSeverity.Error,
  Warning = vim.lsp.protocol.DiagnosticSeverity.Warning,
}

lint.linters.eslint = {
	cmd = "npx",
	args = { "eslint", "--no-color", "--format", "unix", "--stdin" },
	stdin = true,
	stream = "stdout",
	parser = require("lint.parser").from_pattern(pattern, groups, severity_map, { source = "eslint" }),
	ignore_exitcode = true,
}

utils.augroup("TryLint", { "BufWritePost,InsertLeave,BufEnter * lua require('lint').try_lint()" })

-- lspconfig
-- =========
local nvim_lsp = require("lspconfig")
local lsp_status = require("lsp-status")

local function toggle_quickfix() --luacheck: ignore
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
	completion.on_attach(client, bufnr)
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
		diagnostics[i].message = string.format("%s: %s [%s]", v.source, v.message, v.code)
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
	{ "n", "gD", "<Cmd>lua vim.lsp.buf.declaration()<CR>", opts },
	{ "n", "gd", "<Cmd>lua vim.lsp.buf.definition()<CR>", opts },
	{ "n", "K", "<Cmd>lua vim.lsp.buf.hover()<CR>", opts },
	{ "n", "gi", "<cmd>lua vim.lsp.buf.implementation()<CR>", opts },
	{ "n", "<space>D", "<cmd>lua vim.lsp.buf.type_definition()<CR>", opts },
	{ "n", "<space>rn", "<cmd>lua vim.lsp.buf.rename()<CR>", opts },
	{ "n", "<space>ca", "<cmd>lua vim.lsp.buf.code_action()<CR>", opts },
	{ "n", "gr", "<cmd>lua vim.lsp.buf.references()<CR>", opts },
	{ "n", "<space>e", "<cmd>lua vim.lsp.diagnostic.show_line_diagnostics()<CR>", opts },
	-- disable moving into floating window when only one diagnostic: https://github.com/neovim/neovim/issues/15122
	{
		"n",
		"<leader>p",
		"<cmd>lua vim.lsp.diagnostic.goto_prev({popup_opts={focusable=false},severity_limit=4})<CR>",
		opts,
	},
	{
		"n",
		"<leader>n",
		"<cmd>lua vim.lsp.diagnostic.goto_next({popup_opts={focusable=false},severity_limit=4})<CR>",
		opts,
	},
	{ "n", "<space>q", "<cmd>lua toggle_quickfix()<CR>", opts },
	{ "n", "<space>f", "<cmd>lua vim.lsp.buf.formatting()<CR>", opts },
})

-- neoformat
-- =========
utils.augroup("Autoformat", {
	"BufWritePre *.{js,ts,tsx,rs,go,lua} silent! Neoformat",
})

g.neoformat_enabled_javascript = { "prettier" }
g.neoformat_enabled_typescript = { "prettier" }
g.neoformat_enabled_typescriptreact = { "prettier" }
g.neoformat_javascript_prettier = {
	exe = "npx",
	args = { "prettier", "--stdin-filepath", "%:p" },
  stdin = 1,
}

g.neoformat_typescriptreact_prettier = {
	exe = "npx",
	args = { "prettier", "--stdin-filepath", '"%:p"', "--parser", "typescript" },
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
	-- { "n", [[<leader>/]], [[<cmd>Telescope live_grep<cr>]] },
	{ "n", [[<leader>/]], [[:lua require('telescope.builtin').grep_string{ search = vim.fn.input('❯ ' ) }<cr>]] },
	-- { "n", [[<leader><Space>/]], [[<cmd>Telescope live_grep cwd=%:h<cr>]] },
	{ "n", [[<leader>d]], [[:lua require('telescope.builtin').find_files({search_dirs={'%:h'}})<cr>]] },
	{ "n", [[<leader><C-r>]], [[<cmd>Telescope registers<CR>]] },
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
})

-- vim-better-whitespace
-- =====================
require("sodium").highlight("ExtraWhitespace", "Error")

utils.augroup("DisableBetterWhitespace", { "Filetype diff,gitcommit,qf,help,markdown DisableWhitespace" })

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
