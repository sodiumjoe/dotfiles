local utils = require("sodium.utils")
local lint = require("lint")
lint.linters_by_ft = {
	javascript = { "eslint" },
	["javascript.jsx"] = { "eslint" },
	typescript = { "eslint" },
	typescriptreact = { "eslint" },
}

-- /Users/joe/home/my-app/src/App.tsx:5:1: Expected an assignment or function call and instead saw an expression. [Error/@typescript-eslint/no-unused-expressions]
local pattern = ".-:(%d+):(%d+):%s+([%s%w%p]-)%s+%[(.-)/(.*)%]"
local groups = { "line", "start_col", "message", "severity", "code" }
local severity_map = {
	error = vim.lsp.protocol.DiagnosticSeverity.Error,
	warn = vim.lsp.protocol.DiagnosticSeverity.Warning,
}

lint.linters.eslint = {
	cmd = "npx",
	args = { "eslint", "--format", "unix" },
	stdin = false,
	stream = "stdout",
	parser = require("lint.parser").from_pattern(pattern, groups, severity_map, { ["source"] = "eslint" }),
	ignore_exitcode = true,
}

utils.augroup("TryLint", { "BufWrite,InsertLeave,BufEnter <buffer> lua require('lint').try_lint()" })
