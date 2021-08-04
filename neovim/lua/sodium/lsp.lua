local nvim_lsp = require("lspconfig")
local lsp_status = require("lsp-status")

function toggle_quickfix()
	for _, win in pairs(vim.fn.getwininfo()) do
		if win.quickfix == 1 then
			vim.cmd("lclose")
			return
		end
	end
	vim.lsp.diagnostic.set_loclist()
end

-- Use an on_attach function to only map the following keys
-- after the language server attaches to the current buffer
local on_attach = function(client, bufnr)
	-- setup lsp-status
	lsp_status.on_attach(client, buffer)
	local function buf_set_keymap(...)
		vim.api.nvim_buf_set_keymap(bufnr, ...)
	end
	local function buf_set_option(...)
		vim.api.nvim_buf_set_option(bufnr, ...)
	end

	-- Mappings.
	local opts = { noremap = true, silent = true }

	-- See `:help vim.lsp.*` for documentation on any of the below functions
	buf_set_keymap("n", "gD", "<Cmd>lua vim.lsp.buf.declaration()<CR>", opts)
	buf_set_keymap("n", "gd", "<Cmd>lua vim.lsp.buf.definition()<CR>", opts)
	buf_set_keymap("n", "K", "<Cmd>lua vim.lsp.buf.hover()<CR>", opts)
	buf_set_keymap("n", "gi", "<cmd>lua vim.lsp.buf.implementation()<CR>", opts)
	-- buf_set_keymap("n", "<C-k>", "<cmd>lua vim.lsp.buf.signature_help()<CR>", opts)
	--  buf_set_keymap('n', '<space>wa', '<cmd>lua vim.lsp.buf.add_workspace_folder()<CR>', opts)
	--  buf_set_keymap('n', '<space>wr', '<cmd>lua vim.lsp.buf.remove_workspace_folder()<CR>', opts)
	--  buf_set_keymap('n', '<space>wl', '<cmd>lua print(vim.inspect(vim.lsp.buf.list_workspace_folders()))<CR>', opts)
	buf_set_keymap("n", "<space>D", "<cmd>lua vim.lsp.buf.type_definition()<CR>", opts)
	buf_set_keymap("n", "<space>rn", "<cmd>lua vim.lsp.buf.rename()<CR>", opts)
	buf_set_keymap("n", "<space>ca", "<cmd>lua vim.lsp.buf.code_action()<CR>", opts)
	buf_set_keymap("n", "gr", "<cmd>lua vim.lsp.buf.references()<CR>", opts)
	buf_set_keymap("n", "<space>e", "<cmd>lua vim.lsp.diagnostic.show_line_diagnostics()<CR>", opts)
	-- disable moving into floating window when only one diagnostic: https://github.com/neovim/neovim/issues/15122
	buf_set_keymap(
		"n",
		"<leader>p",
		"<cmd>lua vim.lsp.diagnostic.goto_prev({popup_opts={focusable=false},severity_limit=4})<CR>",
		opts
	)
	buf_set_keymap(
		"n",
		"<leader>n",
		"<cmd>lua vim.lsp.diagnostic.goto_next({popup_opts={focusable=false},severity_limit=4})<CR>",
		opts
	)
	buf_set_keymap("n", "<space>q", "<cmd>lua toggle_quickfix()<CR>", opts)
	buf_set_keymap("n", "<space>f", "<cmd>lua vim.lsp.buf.formatting()<CR>", opts)
end

-- Use a loop to conveniently call 'setup' on multiple servers and
-- map buffer local keybindings when the language server attaches
local servers = { "flow", "rust_analyzer", "tsserver" }
for _, lsp in ipairs(servers) do
	nvim_lsp[lsp].setup({
		on_attach = on_attach,
		flags = {
			debounce_text_changes = 150,
		},
	})
end

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
		diagnostics[i].message = string.format("%s: %s", v.source, v.message)
	end

	vim.lsp.diagnostic.save(diagnostics, bufnr, client_id)

	if not vim.api.nvim_buf_is_loaded(bufnr) then
		return
	end

	vim.lsp.diagnostic.display(diagnostics, bufnr, client_id, config)
end

local signs = { Error = " ", Warning = " ", Hint = " ", Information = " " }

for type, icon in pairs(signs) do
	local hl = "LspDiagnosticsSign" .. type
	vim.fn.sign_define(hl, { text = icon, texthl = hl, numhl = "" })
end
