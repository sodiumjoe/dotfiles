local lualine = require("lualine")
local utils = require("sodium.utils")

local non_standard_filetypes = { "", "Trouble", "vimwiki", "help" }

-- Track if LSP has attached at least once
local lsp_attached = false

local function is_standard_filetype()
    local ft = vim.bo.filetype
    for _, filetype in ipairs(non_standard_filetypes) do
        if ft == nil or ft == filetype then
            return false
        end
    end
    return true
end

local filename_active = {
    "filename",
    cond = is_standard_filetype,
    path = 1,
    color = "StatusLineActiveItem",
}

local filename_inactive = {
    "filename",
    cond = is_standard_filetype,
    path = 1,
}

local function get_lines()
    local current_line = vim.fn.line(".")
    local num_lines = vim.fn.line("$")
    local num_digits = string.len(tostring(num_lines))
    return string.format("L%0" .. num_digits .. "d/%d", current_line, num_lines)
end

local function get_column()
    return string.format("C%02d", vim.fn.virtcol("."))
end

local progress_status = {}
local spinner_index = 1
local timer

local function lsp_progress()
    local in_progress_clients = 0
    for _, client in pairs(progress_status) do
        for _, _ in pairs(client) do
            in_progress_clients = in_progress_clients + 1
        end
    end
    return in_progress_clients > 0
end

local function start_timer()
    if timer == nil then
        timer = vim.uv.new_timer()
        if timer ~= nil then
            timer:start(
                0,
                100,
                vim.schedule_wrap(function()
                    if lsp_progress() then
                        spinner_index = (spinner_index % #utils.spinner_frames) + 1
                        lualine.refresh()
                    elseif timer then
                        spinner_index = 1
                        timer:close()
                        timer = nil
                        lualine.refresh()
                    end
                end)
            )
        end
    end
end

local original_progress_handler = vim.lsp.handlers["$/progress"]

---@diagnostic disable-next-line: duplicate-set-field
vim.lsp.handlers["$/progress"] = function(err, msg, info)
    -- Call original handler if it exists
    if original_progress_handler then
        original_progress_handler(err, msg, info)
    end

    local client_id = tostring(info.client_id)
    local token = tostring(msg.token)

    if progress_status[client_id] == nil then
        progress_status[client_id] = {}
    end

    if msg.value.kind == "end" then
        progress_status[client_id][token] = nil
    else
        progress_status[client_id][token] = true
        start_timer()
    end
end

local original_sorbet_handler = vim.lsp.handlers["sorbet/showOperation"]

---@diagnostic disable-next-line: duplicate-set-field
vim.lsp.handlers["sorbet/showOperation"] = function(err, result, context)
    if original_sorbet_handler then
        original_sorbet_handler(err, result, context)
    end

    if err ~= nil then
        error(err)
        return
    end
    local message = {
        token = result.operationName,
        value = {
            kind = result.status == "end" and "end" or "begin",
            title = result.description,
        },
    }
    vim.lsp.handlers["$/progress"](err, message, context)
end

local function lsp_status_component()
    if lsp_progress() then
        return utils.spinner_frames[spinner_index]
    end

    local bufnr = 0
    local error_count = #vim.diagnostic.get(bufnr, { severity = vim.diagnostic.severity.ERROR })
    local warn_count = #vim.diagnostic.get(bufnr, { severity = vim.diagnostic.severity.WARN })
    local info_count = #vim.diagnostic.get(bufnr, { severity = vim.diagnostic.severity.INFO })
    local hint_count = #vim.diagnostic.get(bufnr, { severity = vim.diagnostic.severity.HINT })

    local status_parts = {}
    if error_count > 0 then
        table.insert(status_parts, {
            text = utils.icons.Error .. " " .. error_count,
            color = "StatusLineError",
        })
    end
    if warn_count > 0 then
        table.insert(status_parts, {
            text = utils.icons.Warn .. " " .. warn_count,
            color = "StatusLineWarning",
        })
    end
    if info_count > 0 then
        table.insert(status_parts, {
            text = utils.icons.Info .. " " .. info_count,
            color = "StatusLine",
        })
    end
    if hint_count > 0 then
        table.insert(status_parts, {
            text = utils.icons.Hint .. " " .. hint_count,
            color = "StatusLine",
        })
    end

    if #status_parts == 0 then
        return utils.icons.ok
    end

    local result_parts = {}
    for _, part in ipairs(status_parts) do
        local hl = vim.api.nvim_get_hl(0, { name = part.color })
        if hl.fg then
            table.insert(result_parts, string.format("%%#%s#%s%%*", part.color, part.text))
        else
            table.insert(result_parts, part.text)
        end
    end

    return table.concat(result_parts, " ")
end

local lsp_status = {
    lsp_status_component,
    cond = function()
        return lsp_attached and is_standard_filetype() and #vim.lsp.get_clients({ bufnr = 0 }) > 0
    end,
    padding = 1,
}

local separator = {
    function() return "│" end,
    cond = is_standard_filetype,
    color = "StatusLineSeparator",
    padding = 0,
}

local separator_before_lsp = {
    function() return "│" end,
    cond = function()
        return lsp_attached and is_standard_filetype() and #vim.lsp.get_clients({ bufnr = 0 }) > 0
    end,
    color = "StatusLineSeparator",
    padding = 0,
}

local lines = {
    get_lines,
    cond = is_standard_filetype,
    padding = 1,
}

local column = {
    get_column,
    cond = is_standard_filetype,
    padding = 1,
}

local sections = {
    lualine_a = { filename_active },
    lualine_b = {},
    lualine_c = {},
    lualine_x = { separator_before_lsp, lsp_status, separator, lines, separator, column },
    lualine_y = {},
    lualine_z = {},
}

local inactive_sections = {
    lualine_a = { filename_inactive },
    lualine_b = {},
    lualine_c = {},
    lualine_x = { separator_before_lsp, lsp_status, separator, lines, separator, column },
    lualine_y = {},
    lualine_z = {},
}

local normal = {
    a = { bg = "NONE", fg = "NONE" },
    b = { bg = "NONE", fg = "NONE" },
    c = { bg = "NONE", fg = "NONE" },
}

local theme = {
    normal = normal,
    insert = normal,
    visual = normal,
    replace = normal,
    command = normal,
    inactive = normal,
}

lualine.setup({
    options = {
        theme = theme,
        component_separators = { left = "", right = "" },
        section_separators = { left = "", right = "" },
    },
    sections = sections,
    inactive_sections = inactive_sections,
})

local M = {}

function M.on_attach()
    lsp_attached = true
    lualine.refresh()
end

return M
