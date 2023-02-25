local diagnostics = require("lsp-status/diagnostics")
local redraw = require("lsp-status/redraw")
local utils = require("sodium.utils")

local highlights = {
	reset = "%*",
	active = "%#StatusLineActiveItem#",
	error = "%#StatusLineError#",
	warning = "%#StatusLineWarning#",
	separator = "%#StatusLineSeparator#",
}

local icons = {
	error = utils.icons.Error,
	warning = utils.icons.Warn,
	info = utils.icons.Info,
	hint = utils.icons.Hint,
	ok = utils.icons.ok,
}

local padding = " "
local separator = highlights.separator .. "│" .. highlights.reset
local alignment_group = "%="

local help_modified_read_only = "%(%h%m%r%)"
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
	if vim.api.nvim_buf_get_name(0) == "" then
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

local progress_status = {}
local spinner_index = 1

vim.lsp.handlers["$/progress"] = function(_, msg, info)
	local client_id = tostring(info.client_id)

	local token = tostring(msg.token)
	if progress_status[client_id] == nil then
		progress_status[client_id] = {}
	end

	if msg.value.kind == "end" then
		progress_status[client_id][token] = nil
	else
		progress_status[client_id][token] = true
	end
end

local function lsp_progress()
	local in_progress_clients = 0
	for _, client in pairs(progress_status) do
		for _, _ in pairs(client) do
			in_progress_clients = in_progress_clients + 1
		end
	end
	if in_progress_clients > 0 then
		local spinner_frame = utils.spinner_frames[spinner_index + 1]
		spinner_index = (spinner_index + 1) % #utils.spinner_frames
		redraw.redraw()
		return spinner_frame
	else
		return nil
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

local function insert_item(t, value)
	if value then
		table.insert(t, value)
	end
end

local non_standard_filetypes = { "", "Trouble", "vimwiki", "help" }

local function is_standard_filetype(ft)
	local ret = true
	for _, filetype in ipairs(non_standard_filetypes) do
		if ft == nil or ft == filetype then
			ret = false
			break
		end
	end
	return ret
end

local function get_left_segment(active, standard_filetype)
	local left_segment_items = {}
	local filename = get_filename()
	local highlighted_filename = active and highlight_item(filename, highlights.active) or filename
	insert_item(left_segment_items, highlighted_filename)
	if standard_filetype then
		insert_item(left_segment_items, help_modified_read_only)
	end
	return table.concat(left_segment_items, padding)
end

local function get_right_segment(active, standard_filetype)
	if not standard_filetype then
		return nil
	end
	local right_segment_items = {}
	insert_item(right_segment_items, pad_item(lsp_progress()))
	insert_item(right_segment_items, pad_item(lsp_status()))
	insert_item(right_segment_items, pad_item(get_lines()))
	insert_item(right_segment_items, pad_item(virtual_column))
	return separator .. table.concat(right_segment_items, separator)
end

function _G.statusline(active)
	local standard_filetype = is_standard_filetype(vim.bo.filetype)
	return table.concat({
		get_left_segment(active, standard_filetype),
		get_right_segment(active, standard_filetype),
	}, alignment_group)
end

local autocmd = utils.augroup("StatusLine", { clear = true })

autocmd({ "WinEnter", "BufEnter" }, {
	pattern = "*",
	callback = function()
		vim.opt_local.statusline = [[%{%v:lua.statusline(1)%}]]
	end,
	desc = "Statusline (active)",
})

autocmd({ "WinLeave", "BufLeave" }, {
	pattern = "*",
	callback = function()
		vim.opt_local.statusline = [[%{%v:lua.statusline()%}]]
	end,
	desc = "Statusline (inactive)",
})
