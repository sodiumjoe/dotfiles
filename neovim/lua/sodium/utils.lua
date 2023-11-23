local M = {}

local default_mapping_opts = { noremap = true, silent = true }

function M.is_executable(bin)
	return vim.fn.executable(bin) > 0
end

function M.merge(a, b)
	return vim.tbl_extend("force", a, b)
end

function M.map(mappings)
	for _, m in pairs(mappings) do
		local mode = m[1]
		local lhs = m[2]
		local rhs = m[3]
		local opts = M.merge(default_mapping_opts, m[4] or {})
		vim.keymap.set(mode, lhs, rhs, opts)
	end
end

function M.augroup(name, augroup_opts)
	local group = vim.api.nvim_create_augroup(name, augroup_opts)
	return function(event, opts)
		vim.api.nvim_create_autocmd(event, vim.tbl_extend("force", { group = group }, opts))
	end
end

M.icons = {
	Error = " ",
	Warn = " ",
	Hint = " ",
	Info = " ",
	buffer = " ",
	lsp = " ",
	ok = " ",
}

M.spinner_frames = {
	"",
	"",
	"",
	"",
	"",
	"",
	"",
	"",
	"",
	"",
	"",
	"",
	"",
	"",
	"",
	"",
	"",
	"",
	"",
	"",
	"",
	"",
	"",
	"",
	"",
	"",
	"",
}

function M.is_project_local(root_pattern, config_file)
	local lspconfigUtil = require("lspconfig/util")
	local cwd = vim.fn.getcwd()
	local cwd_root_pattern = lspconfigUtil.path.join(cwd, root_pattern)
	local cwd_config_file = lspconfigUtil.path.join(cwd, config_file)
	if lspconfigUtil.path.exists(cwd_root_pattern) then
		return lspconfigUtil.path.exists(cwd_config_file)
	end
	local buf_name = vim.api.nvim_buf_get_name("%")
	return lspconfigUtil.root_pattern(root_pattern)(buf_name) == lspconfigUtil.root_pattern(config_file)(buf_name)
end

return M
