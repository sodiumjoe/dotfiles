local M = {}

function M.map(mappings)
	for _, m in pairs(mappings) do
		vim.api.nvim_set_keymap(m[1], m[2], m[3], m[4] or {})
	end
end

function M.augroup(name, cmds)
	vim.cmd("augroup " .. name)
	vim.cmd("autocmd!")
	for _, cmd in ipairs(cmds) do
		vim.cmd("autocmd " .. cmd)
	end
	vim.cmd("augroup END")
end

M.icons = {
	Error = " ",
	Warning = " ",
	Hint = " ",
	Information = " ",
}

return M
