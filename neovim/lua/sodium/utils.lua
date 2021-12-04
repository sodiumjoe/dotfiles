local M = {}

function M.map(mappings)
	for _, m in pairs(mappings) do
		vim.api.nvim_set_keymap(m[1], m[2], m[3], m[4] or {})
	end
end

function M.augroup(name, cmds)
	vim.cmd("augroup" .. " " .. name)
	vim.cmd("autocmd!")
	for _, cmd in ipairs(cmds) do
		vim.cmd("autocmd" .. " " .. cmd)
	end
	vim.cmd("augroup END")
end

M.icons = {
	Error = " ",
	Warn = " ",
	Hint = " ",
	Info = " ",
}

function M.is_project_local(root_pattern, config_file)
	local lspconfigUtil = require("lspconfig/util")
	local buf_name = vim.api.nvim_buf_get_name("%")
	return lspconfigUtil.root_pattern(root_pattern)(buf_name) == lspconfigUtil.root_pattern(config_file)(buf_name)
end

return M
