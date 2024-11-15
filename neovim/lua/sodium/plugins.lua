vim.g.popup_opts = {
	focusable = false,
	border = "rounded",
}

-- disable netrw so dirvish will work on startup
vim.g.loaded_netrw = 1
vim.g.loaded_netrwPlugin = 1

local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not vim.loop.fs_stat(lazypath) then
	vim.fn.system({
		"git",
		"clone",
		"--filter=blob:none",
		"https://github.com/folke/lazy.nvim.git",
		"--branch=stable", -- latest stable release
		lazypath,
	})
end
vim.opt.rtp:prepend(lazypath)

local utils = require("sodium.utils")

local autoformat_augroup = vim.api.nvim_create_augroup("LspFormatting", {})

require("lazy").setup({
	{
		"rktjmp/shipwright.nvim",
		cmd = { "Shipwright" },
		dependencies = {
			{ "rktjmp/lush.nvim", lazy = true },
		},
	},
	{
		"benizi/vim-automkdir",
		event = "BufWritePre",
	},
	{
		"echasnovski/mini.move",
		version = "*",
		config = function()
			require("mini.move").setup({
				-- Module mappings. Use `''` (empty string) to disable one.
				mappings = {
					-- Move visual selection in Visual mode. Defaults are Alt (Meta) + hjkl.
					left = "",
					right = "",
					down = "<C-j>",
					up = "<C-k>",

					-- Move current line in Normal mode
					line_left = "",
					line_right = "",
					line_down = "<C-j>",
					line_up = "<C-k>",
				},
			})
		end,
		keys = { "<C-j>", "<C-k>", "v", "V", "<C-v>" },
		dependencies = {
			{ "echasnovski/mini.nvim", version = "*" },
		},
	},
	{
		"folke/trouble.nvim",
		dependencies = {
			{
				"nvim-tree/nvim-web-devicons",
				opts = { default = true },
			},
		},
		cmd = { "Trouble", "TroubleToggle" },
	},
	{
		"haya14busa/is.vim",
		keys = {
			"/",
			"n",
			"N",
			"*",
			"#",
			"g*",
			"g#",
		},
	},
	{
		"hrsh7th/nvim-cmp",
		config = function()
			local luasnip = require("luasnip")
			local cmp = require("cmp")
			local cmdline_mapping = cmp.mapping.preset.cmdline()
			cmdline_mapping["<Tab>"] = nil

			cmp.setup({
				window = {
					completion = vim.g.popup_opts,
					documentation = cmp.config.window.bordered({
						winhighlight = "Normal:Pmenu,FloatBorder:Pmenu,CursorLine:PmenuSel,Search:None",
					}),
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
					["<CR>"] = cmp.mapping.confirm({ select = false }),
					["<Tab>"] = cmp.mapping(function(fallback)
						if luasnip.expand_or_jumpable() then
							luasnip.expand_or_jump()
						else
							fallback()
						end
					end, {
						"i",
						"s",
					}),

					["<S-Tab>"] = cmp.mapping(function(fallback)
						if cmp.visible() then
							cmp.select_prev_item()
						elseif luasnip.jumpable(-1) then
							luasnip.jump(-1)
						else
							fallback()
						end
					end, {
						"i",
						"s",
					}),
				}),
				sources = cmp.config.sources({
					{ name = "nvim_lsp" },
					{
						name = "buffer",
						option = {
							-- completion candidates from all open buffers
							option = {
								get_bufnrs = function()
									return vim.api.nvim_list_bufs()
								end,
							},
						},
					},
					{ name = "path" },
					{ name = "luasnip" },
				}),
				snippet = {
					expand = function(args)
						require("luasnip").lsp_expand(args.body)
					end,
				},
				formatting = {
					format = require("lspkind").cmp_format({
						menu = {
							buffer = utils.icons.buffer,
							nvim_lsp = utils.icons.lsp,
						},
					}),
				},
			})
			cmp.setup.cmdline({ "/", "?" }, {
				mapping = cmdline_mapping,
				sources = {
					{ name = "buffer" },
				},
			})
			cmp.setup.cmdline(":", {
				mapping = cmdline_mapping,
				sources = cmp.config.sources({
					{ name = "path" },
				}, {
					{
						keyword_length = 2,
						name = "cmdline",
						option = {
							ignore_cmds = { "Man", "!" },
						},
					},
				}),
			})
		end,
		dependencies = {
			{ "onsails/lspkind-nvim",     lazy = true },
			{ "hrsh7th/cmp-buffer",       lazy = true },
			{ "hrsh7th/cmp-cmdline",      lazy = true },
			{ "hrsh7th/cmp-nvim-lsp",     lazy = true },
			{ "hrsh7th/cmp-path",         lazy = true },
			{ "L3MON4D3/LuaSnip",         lazy = true },
			{ "saadparwaiz1/cmp_luasnip", lazy = true },
		},
		keys = {
			":",
			"/",
			"?",
		},
		event = { "InsertEnter" },
	},
	{
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
		cmd = { "Goyo" },
	},
	{
		"justinmk/vim-dirvish",
		config = function()
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
	},
	{
		"kaplanz/nvim-retrail",
		opts = {
			-- Highlight group to use for trailing whitespace.
			hlgroup = "Error",
			-- Pattern to match trailing whitespace against. Edit with caution!
			pattern = "\\v((.*%#)@!|%#)\\s+$",
			-- Enabled filetypes.
			filetype = {
				-- Strictly enable only on `include`ed filetypes. When false, only disabled
				-- on an `exclude`ed filetype.
				strict = false,
				-- Included filetype list.
				include = {},
				-- Excluded filetype list. Overrides `include` list.
				exclude = {
					"",
					"aerial",
					"alpha",
					"checkhealth",
					"cmp_menu",
					"diff",
					"lazy",
					"lspinfo",
					"man",
					"mason",
					"TelescopePrompt",
					"Trouble",
					"WhichKey",
					"markdown",
					"javascript",
				},
			},
			-- Enabled buftypes.
			buftype = {
				-- Strictly enable only on `include`ed buftypes. When false, only disabled
				-- on an `exclude`ed buftype.
				strict = false,
				-- Included filetype list. Overrides `include` list.
				include = {},
				-- Excluded filetype list.
				exclude = {
					"help",
					"nofile",
					"prompt",
					"quickfix",
					"terminal",
				},
			},
			-- Trim on write behaviour.
			trim = {
				-- Auto trim on BufWritePre
				auto = true,
				-- Trailing whitespace as highlighted.
				whitespace = true,
				-- Final blank (i.e. whitespace only) lines.
				blanklines = false,
			},
		},
	},
	{
		"kevinhwang91/nvim-hlslens",
		init = function()
			vim.o.hlsearch = true
		end,
		config = function()
			require("hlslens").setup({
				calm_down = true,
				nearest_only = false,
			})

			utils.map({
				{ "n", "n",  "<Plug>(is-n)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<cr>" },
				{ "n", "N",  "<Plug>(is-N)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<cr>" },
				{ "n", "*",  "<Plug>(is-*)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<cr>" },
				{ "n", "#",  "<Plug>(is-#)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<cr>" },
				{ "n", "g*", "<Plug>(is-g*)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<cr>" },
				{ "n", "g#", "<Plug>(is-g#)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<cr>" },
			})
		end,
		keys = {
			"/",
			"n",
			"N",
			"*",
			"#",
			"g*",
			"g#",
		},
	},
	{
		"L3MON4D3/LuaSnip",
		-- follow latest release.
		version = "v2.*", -- Replace <CurrentMajor> by the latest released major (first number of latest release)
		-- install jsregexp (optional!).
		-- build = "make install_jsregexp",
		dependencies = {
			{ "rafamadriz/friendly-snippets", lazy = true },
			{ "saadparwaiz1/cmp_luasnip",     lazy = true },
		},
		config = function()
			require("luasnip.loaders.from_vscode").lazy_load()
			local ls = require("luasnip")
			local s = ls.snippet
			local t = ls.text_node
			local i = ls.insert_node
			local f = ls.function_node
			ls.add_snippets("rust", {
				s("debug", {
					t([[tracing::debug!("]]),
					i(1),
					t([[: {:#?}", ]]),
					f(function(args)
						return args[1][1]
					end, { 1 }),
					t([[);]]),
				}),
			})
		end,
	},
	{
		"luukvbaal/statuscol.nvim",
		init = function()
			vim.diagnostic.config({ severity_sort = true })
		end,
		config = function()
			local builtin = require("statuscol.builtin")
			require("statuscol").setup({
				segments = {
					{
						text = { builtin.lnumfunc },
						sign = { name = { "Diagnostic" } },
					},
					{ text = { " " } },
					{
						sign = {
							name = { "Signify.*" },
							fillchar = "│",
							colwidth = 1,
						},
					},
					{ text = { " " } },
				},
			})
		end,
	},
	{
		"mhinz/vim-signify",
		config = function()
			vim.g.signify_sign_add = "│"
			vim.g.signify_sign_change = "│"
			vim.g.signify_sign_change_delete = "_│"
			vim.g.signify_sign_show_count = 0
			vim.g.signify_skip = { vcs = { allow = { "git" } } }
		end,
	},
	{
		"neovim/nvim-lspconfig",
		config = function()
			local nvim_lsp = require("lspconfig")
			local configs = require("lspconfig.configs")
			local util = require("lspconfig/util")
			local lsp_status = require("lsp-status")

			configs.bazel = {
				default_config = {
					cmd = { "scripts/dev/bazel-lsp" },
					filetypes = { "star", "bzl", "BUILD.bazel" },
					root_dir = util.find_git_ancestor,
				},
				docs = {
					description = [[]],
				},
			}

			configs.vtsls = require("vtsls").lspconfig

			local severity_levels = {
				vim.diagnostic.severity.ERROR,
				vim.diagnostic.severity.WARN,
				vim.diagnostic.severity.INFO,
				vim.diagnostic.severity.HINT,
			}

			local function get_highest_error_severity()
				for _, level in ipairs(severity_levels) do
					local diags = vim.diagnostic.get(0, { severity = { min = level } })
					if #diags > 0 then
						return level, diags
					end
				end
			end

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
			vim.lsp.handlers["textDocument/signatureHelp"] =
				vim.lsp.with(vim.lsp.handlers.signature_help, vim.g.popup_opts)

			local on_attach = function(client, bufnr)
				lsp_status.on_attach(client)

				if client.supports_method("textDocument/formatting") then
					vim.api.nvim_clear_autocmds({ group = autoformat_augroup, buffer = bufnr })
					vim.api.nvim_create_autocmd("BufWritePre", {
						group = autoformat_augroup,
						buffer = bufnr,
						callback = function()
							vim.lsp.buf.format({ timeout_ms = 30000 })
						end,
					})
				end
				require("lspkind").init({})
			end

			local devbox_tsserver_path = "/pay/src/pay-server/frontend/js-scripts/node_modules/typescript/lib"

			local servers = {
				rust_analyzer = {
					settings = {
						["rust-analyzer"] = {
							cargo = {
								features = "all",
							},
						},
					},
				},
				bazel = {},
				sorbet = {
					cmd = {
						"pay",
						"exec",
						"scripts/bin/typecheck",
						"--lsp",
						"--enable-all-experimental-lsp-features",
					},
					init_options = {
						supportsOperationNotifications = true,
						supportsSorbetURIs = true,
					},
					settings = {},
				},
				eslint = {
					cmd_env = { BROWSERSLIST_IGNORE_OLD_DATA = "1" },
					on_attach = function(client, bufnr)
						vim.api.nvim_create_autocmd("BufWritePre", { buffer = bufnr, command = "EslintFixAll" })
						on_attach(client, bufnr)
					end,
				},
				flow = {},
				vtsls = {
					settings = {
						vtsls = vim.fn.isdirectory(devbox_tsserver_path) == 1 and {
							typescript = {
								globalTsdk = devbox_tsserver_path,
							},
						} or {},
						typescript = {
							format = {
								enable = false,
							},
						},
					},
				},
			}

			if utils.is_executable("lua-language-server") then
				servers.lua_ls = {
					settings = {
						Lua = {
							runtime = {
								-- Tell the language server which version of Lua you're using (most likely LuaJIT in the case of Neovim)
								version = "LuaJIT",
							},
							diagnostics = {
								-- Get the language server to recognize the `vim` global
								globals = { "vim" },
							},
							workspace = {
								-- Make the server aware of Neovim runtime files
								library = vim.api.nvim_get_runtime_file("", true),
								checkThirdParty = false, -- THIS IS THE IMPORTANT LINE TO ADD
							},
							-- Do not send telemetry data containing a randomized but unique identifier
							telemetry = {
								enable = false,
							},
						},
					},
				}
			end

			for lsp, options in pairs(servers) do
				local defaults = {
					on_attach = on_attach,
					flags = {
						debounce_text_changes = 150,
					},
					capabilities = vim.tbl_extend("keep", options.capabilities or {}, lsp_status.capabilities),
				}

				local setup_options = vim.tbl_extend("force", defaults, options)

				nvim_lsp[lsp].setup(setup_options)
			end
			utils.map({
				{ "n", "gD",           vim.lsp.buf.declaration },
				-- { "n", "gd", vim.lsp.buf.definition },
				{ "n", "K",            vim.lsp.buf.hover },
				{ "n", "gi",           vim.lsp.buf.implementation },
				{ "n", [[<leader>D]],  vim.lsp.buf.type_definition },
				-- { "n", "<space>rn", "<cmd>lua vim.lsp.buf.rename()<cr>", opts },
				{ "n", [[<leader>ca]], vim.lsp.buf.code_action },
				-- { "n", "gr", vim.lsp.buf.references },
				{ "n", [[<leader>ee]], vim.diagnostic.open_float },
				{
					"n",
					[[<leader>p]],
					function()
						vim.diagnostic.goto_prev({
							severity = get_highest_error_severity(),
						})
					end,
				},
				{
					"n",
					[[<leader>n]],
					function()
						vim.diagnostic.goto_next({
							severity = get_highest_error_severity(),
						})
					end,
				},
				{
					"n",
					[[<leader>q]],
					"<cmd>TroubleToggle<cr>",
				},
				{
					"n",
					[[<leader>f]],
					function()
						vim.lsp.buf.format({ timeout_ms = 30000 })
					end,
				},
			})
		end,
		dependencies = {
			{
				"nvim-lua/lsp-status.nvim",
				config = function()
					require("sodium.statusline")
				end,
			},
			{ "onsails/lspkind-nvim", lazy = true },
			"nvim-telescope/telescope.nvim",
		},
	},
	{
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
					path_display = {
						truncate = 3,
					},
				},
				pickers = {
					buffers = {
						mappings = {
							n = {
								d = "delete_buffer",
							},
						},
					},
				},
			})

			telescope.load_extension("fzf")

			utils.map({
				{
					"n",
					[[<leader>r]],
					function()
						require("telescope.builtin").resume({ initial_mode = "normal" })
					end,
				},
				{
					"n",
					[[<C-p>]],
					function()
						require("telescope.builtin").find_files({ hidden = true })
					end,
				},
				{
					"n",
					[[<leader>s]],
					function()
						require("telescope.builtin").buffers({
							show_all_buffers = true,
							sort_mru = true,
							ignore_current_buffer = true,
							initial_mode = "normal",
						})
					end,
				},
				{
					"n",
					[[<leader>/]],
					function()
						require("telescope.builtin").live_grep()
					end,
				},
				{
					"n",
					[[<leader>8]],
					function()
						require("telescope.builtin").grep_string({
							initial_mode = "normal",
						})
					end,
				},
				{
					"n",
					[[<leader><Space>/]],
					function()
						require("telescope.builtin").live_grep({ cwd = vim.fn.expand("%:h") })
					end,
				},
				-- { "n", [[<leader>d]], [[:lua require('telescope.builtin').find_files({search_dirs={'%:h'}})<cr>]] },
				{
					"n",
					[[<leader>d]],
					function()
						require("telescope.builtin").find_files({
							search_dirs = vim.fn.expand("%:h"),
						})
					end,
				},
				{
					"n",
					[[<leader><C-r>]],
					function()
						require("telescope.builtin").registers()
					end,
				},
				{
					"n",
					[[<leader>g]],
					function()
						require("telescope.builtin").git_status({
							initial_mode = "normal",
							timeout = 100000,
						})
					end,
				},
				{
					"n",
					[[gd]],
					function()
						require("telescope.builtin").lsp_definitions({
							initial_mode = "normal",
						})
					end,
				},
				{
					"n",
					[[gr]],
					function()
						require("telescope.builtin").lsp_references({
							initial_mode = "normal",
						})
					end,
				},
			})
		end,
		dependencies = {
			{ "nvim-telescope/telescope-fzf-native.nvim", build = "make" },
			{
				"nvim-tree/nvim-web-devicons",
				opts = { default = true },
			},
			"nvim-lua/plenary.nvim",
		},
		cmd = { "Telescope" },
	},
	{
		"nvim-treesitter/nvim-treesitter",
		build = ":TSUpdate",
		main = "nvim-treesitter.configs",
		opts = {
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
				"markdown_inline",
				"python",
				"ruby",
				"rust",
				"starlark",
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
		},
	},
	{
		"nvim-treesitter/playground",
		opts = {
			playground = {
				enable = true,
				disable = {},
				updatetime = 25, -- Debounced time for highlighting nodes in the playground from source code
				persist_queries = false, -- Whether the query persists across vim sessions
				keybindings = {
					toggle_query_editor = "o",
					toggle_hl_groups = "i",
					toggle_injected_languages = "t",
					toggle_anonymous_nodes = "a",
					toggle_language_display = "I",
					focus_language = "f",
					unfocus_language = "F",
					update = "R",
					goto_node = "<cr>",
					show_help = "?",
				},
			},
		},
		cmd = { "TSPlaygroundToggle" },
	},
	"nvim-treesitter/nvim-treesitter-context",
	{
		"norcalli/nvim-colorizer.lua",
		config = function()
			require("colorizer").setup()
		end,
	},
	{
		"nvimtools/none-ls.nvim",
		config = function()
			local null_ls = require("null-ls")

			local sources = {
				null_ls.builtins.formatting.buildifier.with({
					condition = function()
						return utils.is_executable("scripts/dev/buildifier")
					end,
					command = "scripts/dev/buildifier",
				}),
				null_ls.builtins.diagnostics.rubocop.with({
					condition = function()
						return utils.is_executable("scripts/bin/rubocop-daemon/rubocop")
					end,
					command = "scripts/bin/rubocop-daemon/rubocop",
				}),
				null_ls.builtins.formatting.prettier.with({
					prefer_local = "node_modules/.bin",
					condition = function(utils)
						return utils.root_has_file("prettier.config.js")
					end,
				}),
			}

			null_ls.setup({
				sources = sources,
				should_attach = function(bufnr)
					return not vim.api.nvim_buf_get_name(bufnr):match("^fugitive://")
				end,
				on_attach = function(client, bufnr)
					if client.supports_method("textDocument/formatting") then
						vim.api.nvim_clear_autocmds({ group = autoformat_augroup, buffer = bufnr })
						vim.api.nvim_create_autocmd("BufWritePre", {
							group = autoformat_augroup,
							buffer = bufnr,
							callback = function()
								vim.lsp.buf.format({ timeout_ms = 30000 })
							end,
						})
					end
				end,
			})
		end,
		dependencies = {
			"neovim/nvim-lspconfig",
		},
	},
	"rafamadriz/friendly-snippets",
	{
		"rachartier/tiny-devicons-auto-colors.nvim",
		dependencies = {
			"nvim-tree/nvim-web-devicons",
		},
		event = "VeryLazy",
		config = function()
			require("tiny-devicons-auto-colors").setup({
				colors = {
					"#3C4C55",
					"#556873",
					"#6A7D89",
					"#899BA6",
					"#C5D4DD",
					"#E6EEF3",
					"#A76969",
					"#DF8C8C",
					"#E7A9A9",
					"#F2C38F",
					"#F5D2AB",
					"#DADA93",
					"#93B481",
					"#A8CE93",
					"#BEDAAE",
					"#93B9E8",
					"#83AFE5",
					"#7399C8",
					"#7FC1CA",
					"#9A93E1",
					"#B3AEE8",
					"#D18EC2",
					"#DDAAD1",
					"#bb0099",
					"#d5508f",
				},
			})
		end,
	},
	"rhysd/conflict-marker.vim",
	{
		"smoka7/hop.nvim",
		config = function()
			require("hop").setup({ create_hl_autocmd = false })
			utils.map({
				{
					"n",
					[[<leader>ew]],
					function()
						require("hop").hint_words()
					end,
				},
				{
					"n",
					[[<leader>e/]],
					function()
						require("hop").hint_patterns()
					end,
				},
			})
		end,
		keys = {
			[[<leader>ew]],
			[[<leader>e/]],
		},
	},
	{
		"sodiumjoe/sodium.nvim",
		-- dir = "~/home/sodium.nvim",
		-- dev = true,
		config = function()
			require("sodium")
			vim.cmd.colorscheme("sodium-dark")
			local line_nr_autocmd = utils.augroup("LineNr", { clear = true })
			-- disable line number in these filetypes
			line_nr_autocmd("FileType", {
				pattern = { "vimwiki", "dirvish", "help" },
				callback = function()
					vim.opt_local.number = false
				end,
			})
			-- disable line number in empty buffer
			line_nr_autocmd({ "BufNewFile", "BufRead", "BufEnter" }, {
				pattern = "*",
				callback = function()
					if vim.filetype.match({ buf = 0 }) == nil then
						vim.opt_local.number = false
					else
						vim.opt_local.number = true
					end
				end,
			})
			local cursorline_autocomd = utils.augroup("CurrentBufferCursorline", { clear = true })
			-- enable cursorline line number highlight in active window
			cursorline_autocomd({ "VimEnter", "WinEnter", "BufWinEnter" }, {
				pattern = "*",
				callback = function()
					vim.opt_local.cursorline = true
				end,
			})
			-- disable cursorline line number highlight in inactive windows
			cursorline_autocomd({ "WinLeave" }, {
				pattern = "*",
				callback = function()
					vim.opt_local.cursorline = false
				end,
			})
		end,
	},
	{
		"tpope/vim-commentary",
		keys = { "gcc", { "gc", mode = "v" } },
	},
	{
		"tpope/vim-eunuch",
		cmd = {
			"Remove",
			"Delete",
			"Move",
			"Chmod",
			"Mkdir",
			"Cfind",
			"Clocate",
			"Wall",
			"SudoWrite",
			"SudoEdit",
		},
	},
	{
		"tpope/vim-fugitive",
		cmd = { "Gdiffsplit", "Git" },
	},
	"tpope/vim-repeat",
	"tpope/vim-surround",
	{
		"vimwiki/vimwiki",
		init = function()
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
			vim.g.vimwiki_hl_headers = 1
			vim.g.vimwiki_hl_cb_checked = 1
			vim.g.vimwiki_listsyms = " ○◐●✓"
		end,
		config = function()
			utils.map({
				{ "n", [[<leader>wp]], "<Plug>VimwikiDiaryPrevDay" },
				{ "n", [[<leader>wn]], "<Plug>VimwikiDiaryNextDay" },
				{ "n", [[<leader>wg]], "<Plug>VimwikiGoto" },
				{ "n", [[<leader>=]],  "<Plug>VimwikiAddHeaderLevel" },
				{ "n", [[<leader>-]],  "<Plug>VimwikiRemoveHeaderLevel" },
			})
		end,
		dependencies = {
			"hrsh7th/nvim-cmp",
		},
		keys = { "<leader>ww", "<leader>w<space>w" },
		ft = "vimwiki",
	},
	"yioneko/nvim-vtsls",
}, {
	defaults = {
		lazy = false,
	},
	-- leave nil when passing the spec as the first argument to setup()
	spec = nil, ---@type LazySpec
	lockfile = "~/.dotfiles/lazy-lock.json",
	dev = {
		-- directory where you store your local plugin projects
		path = "~/home",
		-- --@type string[] plugins that match these patterns will use your local versions instead of being fetched from GitHub
		-- patterns = { "sodiumjoe" }, -- For example {"folke"}
		fallback = false, -- Fallback to git when local plugin doesn't exist
	},
	install = {
		-- install missing plugins on startup. This doesn't increase startup time.
		missing = true,
		-- try to load one of these colorschemes when starting an installation during startup
		colorscheme = { "sodium" },
	},
	ui = {
		-- a number <1 is a percentage., >1 is a fixed size
		size = { width = 0.8, height = 0.8 },
		wrap = true, -- wrap the lines in the ui
		-- The border to use for the UI window. Accepts same border values as |nvim_open_win()|.
		border = "rounded",
	},
	performance = {
		cache = {
			enabled = true,
		},
		reset_packpath = true,       -- reset the package path to improve startup time
		rtp = {
			paths = { "~/.dotfiles/neovim" }, -- add any custom paths here that you want to includes in the rtp
		},
	},
})
