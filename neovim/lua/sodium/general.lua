local utils = require("sodium.utils")
local g = vim.go
local o = vim.o
local w = vim.wo

g.mouse = nil
o.number = true
o.cursorline = true
o.undofile = true
o.splitbelow = true
o.splitright = true
-- Insert only one space when joining lines that contain sentence-terminating
-- punctuation like `.`.
o.joinspaces = false
o.clipboard = [[unnamedplus]]
-- don't show intro message
o.shortmess = [[aoOtI]]
o.completeopt = [[menu,menuone,noselect]]
o.modeline = false

o.infercase = true
o.smartcase = true
o.ignorecase = true
o.inccommand = [[split]]

if utils.is_executable("rg") then
	o.grepprg = [[rg --vimgrep --no-heading -S]]
	o.grepformat = [[%f:%l:%c:%m,%f:%l:%m]]
end

-- display
-- =======
-- folding column width
o.showtabline = 0
o.smartindent = true
o.tabstop = 2
o.shiftwidth = 2
o.expandtab = true
o.scrolloff = 5
g.showmode = false
g.diffopt = [[filler,vertical,algorithm:patience]]
o.guicursor = [[n-v-sm:block-Cursor,i-c-ci-ve:ver25,r-cr-o:hor20]]
o.signcolumn = [[number]]
w.breakindent = true
g.fillchars = [[vert:│,eob:⌁]]
g.splitkeep = "screen"

-- misc
-- ====

utils.augroup("AutoCloseQFLL", { clear = true })("FileType", {
	pattern = { "qf" },
	command = "nnoremap <silent> <buffer> <CR> <CR>:cclose<CR>:lclose<CR>",
})

utils.augroup("RestoreCursorPos", { clear = true })("BufReadPost", {
	pattern = "*",
	command = [[if line("'\"") > 1 && line("'\"") <= line("$") && &ft !~# 'commit' |   exe "normal! g`\"" | endif]],
})

-- javascript source resolution
g.path = "."
o.suffixesadd = ".js"

vim.api.nvim_exec(
	[[
  function! LoadMainNodeModule(fname)
    let nodeModules = "./node_modules/"
    let packageJsonPath = nodeModules . a:fname . "/package.json"

    if filereadable(packageJsonPath)
      return nodeModules . a:fname . "/" . json_decode(join(readfile(packageJsonPath))).main
    else
      return nodeModules . a:fname
    endif
  endfunction

  set includeexpr=LoadMainNodeModule(v:fname)
]],
	false
)

local remote_stripe_dir = "/pay/src/"
local local_stripe_dir = vim.fn.expand("~/stripe")

local function get_lg_url()
	local stripe_dir = nil
	if vim.fn.isdirectory(remote_stripe_dir) ~= 0 then
		stripe_dir = remote_stripe_dir
	elseif vim.fn.isdirectory(local_stripe_dir) ~= 0 then
		stripe_dir = local_stripe_dir
	end

	local full_path = vim.api.nvim_buf_get_name(0)
	local line_number = vim.fn.line(".")
	if stripe_dir ~= nil and string.find(full_path, stripe_dir) then
		local path = string.gsub(full_path, stripe_dir, "")
		return string.format([[http://go/lg-view/%s#L%s]], path, line_number)
	else
		return nil
	end
end

utils.map({
	-- leader d and leader p for deleting instead of cutting and pasting
	-- { "n", [[<leader>d]], [["_d]], { noremap = true } },
	-- { "x", [[<leader>d]], [["_d]], { noremap = true } },
	-- { "x", [[<leader>p]], [["_dP]], { noremap = true } },

	-- movement
	{ "n", "j", "gj" },
	{ "n", "k", "gk" },

	-- search visual selection (busted)
	-- { "v", [[//]], [[y/<C-R>"<CR>]], { noremap = true } },

	-- copy relative path to clipboard
	{ "n", [[<leader>cr]], [[:let @+ = expand("%")<cr>]] },
	-- copy full path to clipboard
	{ "n", [[<leader>cf]], [[:let @+ = expand("%:p")<cr>]] },
	{
		"n",
		[[<leader>l]],
		function()
			local lg_url = get_lg_url()
			if lg_url ~= nil then
				vim.fn.setreg("+", lg_url)
			end
		end,
	},
	{
		"n",
		[[<leader>h]],
		function()
			local ts_result = vim.treesitter.get_captures_at_cursor(0)
			local lsp_result = vim.lsp.semantic_tokens.get_at_pos()
			print(vim.inspect({ ts = ts_result, lsp = lsp_result }))
		end,
	},
})
