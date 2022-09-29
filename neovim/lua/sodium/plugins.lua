local fn = vim.fn

vim.g.popup_opts = {
	focusable = false,
	border = "rounded",
}

local packer_bootstrap
local install_path = fn.stdpath("data") .. "/site/pack/packer/start/packer.nvim"
if fn.empty(fn.glob(install_path)) > 0 then
	packer_bootstrap = fn.system({
		"git",
		"clone",
		"--depth",
		"1",
		"https://github.com/wbthomason/packer.nvim",
		install_path,
	})
	vim.cmd([[packadd packer.nvim]])
end

require("packer").startup(function(use)
	use("wbthomason/packer.nvim")
	use("nvim-lua/plenary.nvim")
	use("benizi/vim-automkdir")
	use({
		"christoomey/vim-tmux-navigator",
		config = function()
			vim.g.tmux_navigator_no_mappings = 1
			require("sodium.utils").map({
				{ "n", "<C-w>h", ":TmuxNavigateLeft<cr>" },
				{ "n", "<C-w>j", ":TmuxNavigateDown<cr>" },
				{ "n", "<C-w>k", ":TmuxNavigateUp<cr>" },
				{ "n", "<C-w>l", ":TmuxNavigateRight<cr>" },
				{ "n", "<C-w>w", ":TmuxNavigatePrevious<cr>" },
			})
		end,
	})
	use({
		"editorconfig/editorconfig-vim",
		config = function()
			vim.g.EditorConfig_exclude_patterns = { "fugitive://.*" }
		end,
	})
	use("folke/trouble.nvim")
	use("haya14busa/is.vim")
	use("hrsh7th/cmp-nvim-lsp")
	use("hrsh7th/cmp-buffer")
	use("hrsh7th/cmp-path")
	use({
		"hrsh7th/nvim-cmp",
		config = function()
			local cmp = require("cmp")
			cmp.setup({
				window = {
					documentation = vim.g.popup_opts,
				},
				view = {
					entries = { name = "custom", selection_order = "near_cursor" },
				},
				mapping = cmp.mapping.preset.insert({
					["<C-n>"] = function(fallback)
						if cmp.visible() then
							cmp.select_next_item()
						else
							fallback()
						end
					end,
					["<C-p>"] = function(fallback)
						if cmp.visible() then
							cmp.select_prev_item()
						else
							fallback()
						end
					end,
				}),
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
		end,
		requires = {
			"onsails/lspkind-nvim",
			"hrsh7th/cmp-nvim-lsp",
			"hrsh7th/cmp-path",
			"hrsh7th/vim-vsnip",
		},
	})
	use("hrsh7th/vim-vsnip")
	use({
		"jose-elias-alvarez/null-ls.nvim",
		config = function()
			local null_ls = require("null-ls")
			local utils = require("sodium.utils")

			local sources = {
				null_ls.builtins.diagnostics.eslint_d.with({
					condition = function()
						return utils.is_executable("eslint_d")
					end,
					cwd = function(params)
						return require("lspconfig/util").root_pattern(".eslintrc.js")(params.bufname)
					end,
				}),
				null_ls.builtins.diagnostics.eslint.with({
					condition = function()
						return utils.is_executable("eslint") and not utils.is_executable("eslint_d")
					end,
					prefer_local = true,
				}),
				null_ls.builtins.diagnostics.rubocop.with({
					condition = function()
						return utils.is_executable("scripts/bin/rubocop-daemon/rubocop")
					end,
					command = "scripts/bin/rubocop-daemon/rubocop",
				}),
				null_ls.builtins.formatting.eslint_d.with({
					condition = function()
						return utils.is_executable("eslint_d")
					end,
					cwd = function(params)
						return require("lspconfig/util").root_pattern(".eslintrc.js")(params.bufname)
					end,
				}),
				null_ls.builtins.formatting.eslint.with({
					condition = function()
						return utils.is_executable("eslint") and not utils.is_executable("eslint_d")
					end,
					prefer_local = true,
				}),
				null_ls.builtins.formatting.rustfmt,
				null_ls.builtins.formatting.stylua.with({
					condition = function()
						return utils.is_executable("stylua")
					end,
				}),
				null_ls.builtins.formatting.rustfmt,
			}

			local augroup = vim.api.nvim_create_augroup("LspFormatting", {})
			null_ls.setup({
				sources = sources,
				on_attach = function(client, bufnr)
					if client.supports_method("textDocument/formatting") then
						vim.api.nvim_clear_autocmds({ group = augroup, buffer = bufnr })
						vim.api.nvim_create_autocmd("BufWritePre", {
							group = augroup,
							buffer = bufnr,
							callback = function()
								vim.lsp.buf.formatting_sync()
							end,
						})
					end
				end,
			})
		end,
		requires = {
			"neovim/nvim-lspconfig",
		},
	})
	use({
		"junegunn/goyo.vim",
		config = function()
			vim.cmd([[
        function! s:goyo_enter()
          set linebreak
        endfunction

        function! s:goyo_leave()
          set nolinebreak
        endfunction

        autocmd! User GoyoEnter nested call <SID>goyo_enter()
        autocmd! User GoyoLeave nested call <SID>goyo_leave()
      ]])
		end,
	})
	use({
		"justinmk/vim-dirvish",
		config = function()
			local utils = require("sodium.utils")
			local dirvish_autocmd = utils.augroup("DirvishConfig", { clear = true })
			dirvish_autocmd("FileType", {
				pattern = { "dirvish" },
				command = "silent! unmap <buffer> <C-p>",
			})
			dirvish_autocmd("FileType", {
				pattern = { "dirvish" },
				command = "silent! unmap <buffer> <C-n>",
			})
		end,
	})
	use({
		"kevinhwang91/nvim-hlslens",
		config = function()
			require("hlslens").setup({
				calm_down = true,
				nearest_only = false,
			})

			vim.o.hlsearch = true

			require("sodium.utils").map({
				{ "n", "n", "<Plug>(is-n)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<cr>" },
				{ "n", "N", "<Plug>(is-N)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<cr>" },
				{ "n", "*", "<Plug>(is-*)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<cr>" },
				{ "n", "#", "<Plug>(is-#)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<cr>" },
				{ "n", "g*", "<Plug>(is-g*)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<cr>" },
				{ "n", "g#", "<Plug>(is-g#)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<cr>" },
			})
		end,
	})
	use({
		"kyazdani42/nvim-web-devicons",
		config = function()
			require("nvim-web-devicons").setup({
				default = true,
			})
		end,
	})
	use({
		"matze/vim-move",
		config = function()
			vim.g.move_key_modifier = "C"
		end,
	})
	use({
		"mhinz/vim-signify",
		config = function()
			vim.g.signify_sign_add = "│"
			vim.g.signify_sign_change = "│"
			vim.g.signify_sign_change_delete = "_│"
			vim.g.signify_sign_show_count = 0
		end,
	})
	use({
		"neovim/nvim-lspconfig",
		config = function()
			local nvim_lsp = require("lspconfig")
			local lsp_status = require("lsp-status")
			local utils = require("sodium.utils")

			vim.diagnostic.config({
				signs = { priority = 11 },
				virtual_text = false,
				update_in_insert = false,
				float = {
					focusable = vim.g.popup_opts.focusable,
					border = vim.g.popup_opts.border,
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

			vim.lsp.handlers["textDocument/hover"] = vim.lsp.with(vim.lsp.handlers.hover, vim.g.popup_opts)
			vim.lsp.handlers["textDocument/signatureHelp"] = vim.lsp.with(
				vim.lsp.handlers.signature_help,
				vim.g.popup_opts
			)

			local on_attach = function(client, bufnr)
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

			if utils.is_executable("lua-language-server") then
				servers.sumneko_lua = {
					on_attach = function(client, bufnr)
						client.resolved_capabilities.document_formatting = false
						on_attach(client, bufnr)
					end,
				}
			end

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
			utils.map({
				{ "n", "gD", "", { callback = vim.lsp.buf.declaration } },
				{ "n", "gd", "", { callback = vim.lsp.buf.definition } },
				{ "n", "K", "", { callback = vim.lsp.buf.hover } },
				{ "n", "gi", "", { callback = vim.lsp.buf.implementation } },
				{ "n", "<space>D", "", { callback = vim.lsp.buf.type_definition } },
				-- { "n", "<space>rn", "<cmd>lua vim.lsp.buf.rename()<cr>", opts },
				{ "n", "<space>ca", "", { callback = vim.lsp.buf.code_action } },
				{ "n", "gr", "", { callback = vim.lsp.buf.references } },
				{ "n", "<space>ee", "", { callback = vim.lsp.diagnostic.show_line_diagnostics } },
				{ "n", "<leader>p", "", { callback = vim.diagnostic.goto_prev } },
				{ "n", "<leader>n", "", { callback = vim.diagnostic.goto_next } },
				{
					"n",
					"<space>q",
					"",
					{
						callback = function()
							vim.diagnostic.setqflist({ open = false })
							require("telescope.builtin").quickfix({ initial_mode = "normal" })
						end,
					},
				},
				{ "n", "<space>f", "", { callback = vim.lsp.buf.formatting } },
			})
		end,
		requires = {
			"nvim-lua/lsp-status.nvim",
			"onsails/lspkind-nvim",
			"nvim-telescope/telescope.nvim",
		},
	})
	use("nvim-lua/lsp-status.nvim")
	use("nvim-lua/popup.nvim")
	use({
		"nvim-telescope/telescope.nvim",
		config = function()
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

			require("sodium.utils").map({
				{
					"n",
					[[<leader>r]],
					"",
					{
						callback = function()
							require("telescope.builtin").resume({ initial_mode = "normal" })
						end,
					},
				},
				{
					"n",
					[[<C-p>]],
					"",
					{
						callback = function()
							require("telescope.builtin").find_files({ hidden = true })
						end,
					},
				},
				{
					"n",
					[[<leader>s]],
					"",
					{
						callback = function()
							require("telescope.builtin").buffers({
								show_all_buffers = true,
								sort_mru = true,
								ignore_current_buffer = true,
								initial_mode = "normal",
							})
						end,
					},
				},
				{ "n", [[<leader>8]], "", {
					callback = require("telescope.builtin").grep_string,
				} },
				{
					"n",
					[[<leader>/]],
					"",
					{
						callback = require("telescope.builtin").live_grep,
					},
				},
				{
					"n",
					[[<leader><Space>/]],
					"",
					{
						callback = function()
							require("telescope.builtin").live_grep({ cwd = vim.fn.expand("%:h") })
						end,
					},
				},
				-- { "n", [[<leader>d]], [[:lua require('telescope.builtin').find_files({search_dirs={'%:h'}})<cr>]] },
				{
					"n",
					[[<leader>d]],
					"",
					{
						callback = function()
							require("telescope.builtin").find_files({ search_dirs = vim.fn.expand("%:h") })
						end,
					},
				},
				{ "n", [[<leader><C-r>]], "", { callback = require("telescope.builtin").registers } },
				{
					"n",
					[[<leader>g]],
					"",
					{
						callback = function()
							require("telescope.builtin").git_status({ use_git_root = false, initial_mode = "normal" })
						end,
					},
				},
			})
		end,
		requires = {
			"nvim-telescope/telescope-fzf-native.nvim",
		},
	})
	use({ "nvim-telescope/telescope-fzf-native.nvim", run = "make" })
	use({
		"nvim-treesitter/nvim-treesitter",
		run = function()
			if vim.fn.exists(":TSUpdate") == 2 then
				vim.cmd(":TSUpdate")
			end
		end,
		config = function()
			require("nvim-treesitter.configs").setup({
				ensure_installed = {
					"bash",
					"css",
					"go",
					"html",
					"java",
					"javascript",
					"json",
					"lua",
					"markdown",
					"python",
					"ruby",
					"rust",
					"tsx",
					"typescript",
					"vim",
					"yaml",
				},
				-- https://github.com/nvim-treesitter/nvim-treesitter/issues/1313
				ignore_install = { "comment", "jsdoc" },
				highlight = {
					enable = true,
					disable = {},
				},
			})
		end,
	})
	use({
		"ikatyang/tree-sitter-markdown",
		config = function()
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
		end,
		requires = {
			"nvim-treesitter/nvim-treesitter",
		},
	})
	use({
		"norcalli/nvim-colorizer.lua",
		config = function()
			require("colorizer").setup()
		end,
	})
	use("onsails/lspkind-nvim")
	use({
		"ntpeters/vim-better-whitespace",
		config = function()
			local utils = require("sodium.utils")
			utils.augroup("DisableBetterWhitespace", { clear = true })("Filetype", {
				pattern = { "diff", "gitcommit", "qf", "help", "markdown", "javascript" },
				command = "DisableWhitespace",
			})
		end,
	})
	use({
		"phaazon/hop.nvim",
		config = function()
			require("hop").setup({ create_hl_autocmd = false })
			vim.api.nvim_command([[hi clear HopUnmatched]])
			require("sodium.utils").map({
				{
					"n",
					"<leader>ew",
					"",
					{
						callback = require("hop").hint_words,
					},
				},
				{ "n", "<leader>e/", "", {
					callback = require("hop").hint_patterns,
				} },
			})
		end,
	})
	use("rhysd/conflict-marker.vim")
	use("sodiumjoe/nvim-highlite")
	use("tpope/vim-commentary")
	use("tpope/vim-eunuch")
	use("tpope/vim-fugitive")
	use("tpope/vim-repeat")
	use("tpope/vim-surround")
	use({
		"vimwiki/vimwiki",
		config = function()
			local utils = require("sodium.utils")
			local wiki = {
				path = "~/home/todo.wiki",
				syntax = "markdown",
			}
			local work_wiki = {
				path = "~/stripe/todo.wiki",
				path_html = "~/stripe/todo.html",
				syntax = "markdown",
			}

			if vim.fn.isdirectory(vim.fn.expand("~/stripe")) ~= 0 then
				vim.g.vimwiki_list = { work_wiki, wiki }
			else
				vim.g.vimwiki_list = { wiki }
			end
			vim.g.vimwiki_auto_header = 1

			local vimwiki_autocmd = utils.augroup("Vimwiki", { clear = true })

			vimwiki_autocmd("FileType", {
				pattern = { "vimwiki" },
				command = "nmap <buffer> <leader>wn <Plug>VimwikiDiaryNextDay",
			})
			vimwiki_autocmd("FileType", {
				pattern = { "vimwiki" },
				callback = function()
					require("cmp").setup.buffer({ enabled = false })
				end,
			})

			utils.map({
				{ "n", "<leader>wp", "<Plug>VimwikiDiaryPrevDay" },
				{ "n", "<leader>=", "<Plug>VimwikiAddHeaderLevel" },
				{ "n", "<leader>-", "<Plug>VimwikiRemoveHeaderLevel" },
			})
		end,
		requires = {
			"hrsh7th/nvim-cmp",
		},
	})
	use({
		"whatyouhide/vim-lengthmatters",
		config = function()
			vim.cmd("call lengthmatters#highlight('ctermbg=0 guibg=#556873')")
			vim.g.lengthmatters_excluded = {
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
		end,
	})

	-- Automatically set up your configuration after cloning packer.nvim
	-- Put this at the end after all plugins
	if packer_bootstrap then
		require("packer").sync()
	end
end)
