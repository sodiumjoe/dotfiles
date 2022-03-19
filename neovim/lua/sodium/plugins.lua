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
vim.fn["plug#"]("folke/trouble.nvim")
vim.fn["plug#"]("haya14busa/is.vim")
vim.fn["plug#"]("hrsh7th/cmp-nvim-lsp")
vim.fn["plug#"]("hrsh7th/cmp-buffer")
vim.fn["plug#"]("hrsh7th/cmp-path")
vim.fn["plug#"]("hrsh7th/nvim-cmp")
vim.fn["plug#"]("hrsh7th/vim-vsnip")
vim.fn["plug#"]("jose-elias-alvarez/null-ls.nvim")
vim.fn["plug#"]("junegunn/goyo.vim")
vim.fn["plug#"]("justinmk/vim-dirvish")
vim.fn["plug#"]("kevinhwang91/nvim-hlslens")
vim.fn["plug#"]("kyazdani42/nvim-web-devicons")
vim.fn["plug#"]("matze/vim-move")
vim.fn["plug#"]("mhinz/vim-signify")
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
vim.fn["plug#"]("sodiumjoe/nvim-highlite")
vim.fn["plug#"]("tpope/vim-commentary")
vim.fn["plug#"]("tpope/vim-eunuch")
vim.fn["plug#"]("tpope/vim-fugitive")
vim.fn["plug#"]("tpope/vim-repeat")
vim.fn["plug#"]("tpope/vim-surround")
vim.fn["plug#"]("vimwiki/vimwiki")
vim.fn["plug#"]("whatyouhide/vim-lengthmatters")

vim.fn["plug#end"]()

g.popup_opts = {
	focusable = false,
	border = "rounded",
}

-- colorizer
-- =========
require("colorizer").setup()

-- signify
-- =======
g.signify_sign_add = "│"
g.signify_sign_change = "│"
g.signify_sign_change_delete = "_│"
g.signify_sign_show_count = 0

-- cmp
-- ===
local cmp = require("cmp")
cmp.setup({
	documentation = g.popup_opts,
	sources = cmp.config.sources({
		{
			name = "buffer",
			option = {
				-- completion candidates from all open buffers
				get_bufnrs = function()
					local bufs = {}
					for _, win in ipairs(vim.api.nvim_list_wins()) do
						local buf_num = vim.api.nvim_win_get_buf(win)
						local ft = vim.api.nvim_buf_get_option(buf_num, "filetype")
						-- don't complete from json and graphql buffers
						if ft ~= "json" and ft ~= "graphql" then
							bufs[buf_num] = true
						end
					end
					return vim.tbl_keys(bufs)
				end,
			},
		},
		{ name = "nvim_lsp" },
		{ name = "path" },
	}),
	snippet = {
		expand = function(args)
			vim.fn["vsnip#anonymous"](args.body)
		end,
	},
	formatting = {
		format = require("lspkind").cmp_format({
			menu = {
				buffer = "[Buffer]",
				nvim_lsp = "[LSP]",
			},
		}),
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
require("hop").setup({ create_hl_autocmd = false })
vim.api.nvim_command([[hi clear HopUnmatched]])

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

-- null-ls
-- =======
local null_ls = require("null-ls")

-- in lua, `0` evaluates as truthy
local function is_executable(bin)
	return vim.fn.executable(bin) > 0
end

local sources = {
	null_ls.builtins.diagnostics.eslint_d.with({
		condition = function()
			return is_executable("eslint_d")
		end,
		cwd = function(params)
			return require("lspconfig/util").root_pattern(".eslintrc.js")(params.bufname)
		end,
	}),
	null_ls.builtins.diagnostics.eslint.with({
		condition = function()
			return is_executable("eslint") and not is_executable("eslint_d")
		end,
		prefer_local = true,
	}),
	null_ls.builtins.diagnostics.luacheck,
	null_ls.builtins.diagnostics.rubocop.with({
		condition = function()
			return is_executable("scripts/bin/rubocop-daemon/rubocop")
		end,
		command = "scripts/bin/rubocop-daemon/rubocop",
	}),
	null_ls.builtins.formatting.eslint_d.with({
		condition = function()
			return is_executable("eslint_d")
		end,
		cwd = function(params)
			return require("lspconfig/util").root_pattern(".eslintrc.js")(params.bufname)
		end,
	}),
	null_ls.builtins.formatting.eslint.with({
		condition = function()
			return is_executable("eslint") and not is_executable("eslint_d")
		end,
		prefer_local = true,
	}),
	null_ls.builtins.formatting.stylua.with({
		condition = function()
			return is_executable("stylua")
		end,
	}),
	null_ls.builtins.formatting.rustfmt,
}

null_ls.setup({
	sources = sources,
	on_attach = function(client)
		-- setup lsp-status
		if client.resolved_capabilities.document_formatting then
			vim.cmd([[
        augroup LspFormatting
            autocmd! * <buffer>
            autocmd BufWritePre <buffer> lua vim.lsp.buf.formatting_sync()
        augroup END
        ]])
		end
	end,
})

-- lspconfig
-- =========
local nvim_lsp = require("lspconfig")
local lsp_status = require("lsp-status")

vim.diagnostic.config({
	signs = { priority = 11 },
	virtual_text = false,
	update_in_insert = false,
	float = {
		focusable = g.popup_opts.focusable,
		border = g.popup_opts.border,
		format = function(diagnostic)
			local str = string.format("[%s] %s", diagnostic.source, diagnostic.message)
			if diagnostic.code then
				str = str .. " (" .. diagnostic.code .. ")"
			end
			return str
		end,
	},
})

for type, icon in pairs(utils.icons) do
	local hl = "DiagnosticSign" .. type
	vim.fn.sign_define(hl, { text = icon, texthl = hl, numhl = "" })
end

vim.lsp.handlers["textDocument/hover"] = vim.lsp.with(vim.lsp.handlers.hover, g.popup_opts)
vim.lsp.handlers["textDocument/signatureHelp"] = vim.lsp.with(vim.lsp.handlers.signature_help, g.popup_opts)

local on_attach = function(client, bufnr)
	if client.resolved_capabilities.document_formatting then
		vim.cmd([[
        augroup LspFormatting
            autocmd! * <buffer>
            autocmd BufWritePre <buffer> lua vim.lsp.buf.formatting_sync()
        augroup END
        ]])
	end
	lsp_status.on_attach(client, bufnr)
	require("lspkind").init({})
end

local servers = {
	rust_analyzer = {},
	tsserver = {
		cmd_env = { NODE_OPTIONS = "--max-old-space-size=8192" },
		on_attach = function(client, bufnr)
			client.resolved_capabilities.document_formatting = false
			on_attach(client, bufnr)
		end,
		init_options = {
			maxTsServerMemory = "8192",
		},
		filetypes = { "typescript", "typescriptreact", "typescript.tsx" },
	},
	sorbet = {
		cmd = { "pay", "exec", "scripts/bin/typecheck", "--lsp" },
	},
	flow = {},
}

for lsp, options in pairs(servers) do
	local defaults = {
		on_attach = on_attach,
		flags = {
			debounce_text_changes = 150,
		},
		capabilities = lsp_status.capabilities,
	}

	local setup_options = vim.tbl_extend("force", defaults, options)

	nvim_lsp[lsp].setup(setup_options)
end

function _G.project_diagnostics()
	vim.diagnostic.setqflist({ open = false })
	require("telescope.builtin").quickfix({ initial_mode = "normal" })
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
		"<cmd>lua vim.lsp.diagnostic.show_line_diagnostics()<cr>",
		opts,
	},
	{
		"n",
		"<leader>p",
		-- disable moving into floating window when only one diagnostic: https://github.com/neovim/neovim/issues/15122
		"<cmd>lua vim.diagnostic.goto_prev()<cr>",
		opts,
	},
	{
		"n",
		"<leader>n",
		"<cmd>lua vim.diagnostic.goto_next()<cr>",
		opts,
	},
	{ "n", "<space>q", "<cmd>lua project_diagnostics()<cr>", opts },
	{ "n", "<space>f", "<cmd>lua vim.lsp.buf.formatting()<cr>", opts },
})

-- telescope
-- =========
local telescope = require("telescope")
telescope.setup({
	defaults = {
		selection_caret = "  ",
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
	-- https://github.com/nvim-treesitter/nvim-treesitter/issues/1313
	ignore_install = { "comment", "jsdoc" },
	highlight = {
		enable = true,
		disable = {},
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

if vim.fn.isdirectory("~/stripe") ~= 0 then
	g.vimwiki_list = { work_wiki, wiki }
else
	g.vimwiki_list = { wiki }
end
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
