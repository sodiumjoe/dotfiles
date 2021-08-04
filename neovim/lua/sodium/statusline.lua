local diagnostics = require("lsp-status/diagnostics")
local utils = require("sodium.utils")

local highlights = {
	reset = "%*",
	active = "%#StatusLineActiveItem#",
	error = "%#StatusLineError#",
	warning = "%#StatusLineWarning#",
	separator = "%#StatusLineSeparator#",
}

local signs = { Error = " ", Warning = " ", Hint = " ", Information = " " }

local icons = {
	error = "",
	warning = "",
	info = "",
	hint = "",
	ok = "☑",
}

local padding = " "
local separator = highlights.separator .. "│" .. highlights.reset
local alignment_group = "%="

local help_modified_read_only = "%(%h%m%r%)"
local lines = "L%l/%L"
local virtual_column = "C%02v"

local function highlight_item(item, h)
	if item == nil then
		return nil
	end
	return h .. item .. highlights.reset
end

local function pad_item(item)
	if item == nil then
		return nil
	end
	return padding .. item .. padding
end

local function get_filename()
	local filetype = vim.bo.filetype
	if filetype == "" then
		return nil
	end

	local filename

	if filetype == "dirvish" then
		filename = '%<%{expand("%:~")}'
	elseif filetype == "help" then
		filename = '%<%{expand("%:t:r")}'
	else
		filename = '%<%{expand("%:~:.")}'
	end

	return pad_item(filename)
end

local function get_lines()
	-- pad current line number to number of digits in total lines to keep length
	-- of segment consistent
	local num_lines = vim.fn.line("$")
	local num_digits = string.len(num_lines)
	return "L%0" .. num_digits .. "l/%L"
end

local function insert_diagnostic_part(status_parts, diagnostic, type)
	if diagnostic and diagnostic > 0 then
		if highlights[type] then
			table.insert(status_parts, highlight_item(icons[type] .. padding .. diagnostic, highlights[type]))
		else
			table.insert(status_parts, icons[type] .. padding .. diagnostic)
		end
	end
end

local function lsp_status()
	local bufnr = 0
	if #vim.lsp.buf_get_clients(bufnr) == 0 then
		return nil
	end
	local buf_diagnostics = diagnostics(bufnr) or nil
	if buf_diagnostics == nil then
		return nil
	end

	local status_parts = {}

	insert_diagnostic_part(status_parts, buf_diagnostics.errors, "error")
	insert_diagnostic_part(status_parts, buf_diagnostics.warnings, "warning")
	insert_diagnostic_part(status_parts, buf_diagnostics.info, "info")
	insert_diagnostic_part(status_parts, buf_diagnostics.hints, "hint")

	if #status_parts == 0 then
		return icons.ok
	end
	return table.concat(status_parts, " ")
end

function insert_item(t, value)
	if value then
		table.insert(t, value)
	end
end

function _G.active_line()
	local left_segment_items = {}
	insert_item(left_segment_items, highlight_item(get_filename(), highlights.active))
	insert_item(left_segment_items, help_modified_read_only)
	local left_segment = table.concat(left_segment_items, padding)

	local right_segment_items = {}
	insert_item(right_segment_items, pad_item(lsp_status()))
	insert_item(right_segment_items, pad_item(get_lines()))
	insert_item(right_segment_items, pad_item(virtual_column))

	local right_segment = separator .. table.concat(right_segment_items, separator)

	return table.concat({ left_segment, right_segment }, alignment_group)
end

function _G.inactive_line()
	local left_segment_items = {}
	insert_item(left_segment_items, get_filename())
	insert_item(left_segment_items, help_modified_read_only)
	local left_segment = table.concat(left_segment_items, padding)

	local right_segment_items = {}
	insert_item(right_segment_items, pad_item(lsp_status()))
	insert_item(right_segment_items, pad_item(get_lines()))
	insert_item(right_segment_items, pad_item(virtual_column))

	local right_segment = separator .. table.concat(right_segment_items, separator)

	return table.concat({ left_segment, right_segment }, alignment_group)
end

utils.augroup("StatusLine", {
	"WinEnter,BufEnter * setlocal statusline=%{%v:lua.active_line()%}",
	"WinLeave,BufLeave * setlocal statusline=%{%v:lua.inactive_line()%}",
})
