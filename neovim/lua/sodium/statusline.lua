local lualine = require("lualine")
local utils = require("sodium.utils")


local non_standard_filetypes = { "", "Trouble", "vimwiki", "help" }
local agentic_filetypes = { "AgenticChat", "AgenticInput", "AgenticCode", "AgenticFiles", "AgenticTodos" }

-- Track if LSP has attached at least once
local lsp_attached = false

local function is_fugitive_buffer()
    return vim.api.nvim_buf_get_name(0):match("^fugitive://") ~= nil
end

local function is_standard_filetype()
    local ft = vim.bo.filetype
    for _, filetype in ipairs(non_standard_filetypes) do
        if ft == nil or ft == filetype then
            return false
        end
    end
    return true
end

local function get_filename()
    local bufname = vim.api.nvim_buf_get_name(0)
    local _, _, filepath = bufname:match("^fugitive://(.+)//(%x+)/(.+)$")
    if filepath then
        return "[staged]: " .. filepath
    end
    return vim.fn.fnamemodify(bufname, ":~:.")
end

local filename_active = {
    get_filename,
    cond = is_standard_filetype,
    color = "StatusLineActiveItem",
}

local filename_inactive = {
    get_filename,
    cond = is_standard_filetype,
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
        return lsp_attached and is_standard_filetype() and not is_fugitive_buffer() and
            #vim.lsp.get_clients({ bufnr = 0 }) > 0
    end,
    padding = 1,
}

local function separator_if(cond_fn)
    return {
        function() return "│" end,
        cond = cond_fn,
        color = "StatusLineSeparator",
        padding = 0,
    }
end

local separator = separator_if(is_standard_filetype)

local separator_before_lsp = separator_if(function()
    return lsp_attached and is_standard_filetype() and not is_fugitive_buffer() and
        #vim.lsp.get_clients({ bufnr = 0 }) > 0
end)

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

local function get_agentic_title()
    local ft = vim.bo.filetype
    if ft == "AgenticChat" then
        return "󰻞 Agentic Chat"
    elseif ft == "AgenticInput" then
        return "󰦨 Prompt"
    elseif ft == "AgenticCode" then
        return "󰪸 Selected Code Snippets"
    elseif ft == "AgenticFiles" then
        return "󰪸 Referenced Files"
    elseif ft == "AgenticTodos" then
        return "☐ TODO Items"
    end
    return ""
end

local agentic_spinner_index = 1
local agentic_timer

local function start_agentic_timer()
    if agentic_timer == nil then
        agentic_timer = vim.uv.new_timer()
        if agentic_timer ~= nil then
            agentic_timer:start(
                0,
                100,
                vim.schedule_wrap(function()
                    local ok, session_registry = pcall(require, "agentic.session_registry")
                    if not ok then
                        if agentic_timer then
                            agentic_timer:close()
                            agentic_timer = nil
                        end
                        return
                    end

                    local tab_page_id = vim.api.nvim_get_current_tabpage()
                    local session_manager = session_registry.get_session_for_tab_page(tab_page_id)

                    if session_manager and session_manager.is_generating then
                        agentic_spinner_index = (agentic_spinner_index % #utils.spinner_frames) + 1
                        lualine.refresh()
                    elseif agentic_timer then
                        agentic_spinner_index = 1
                        agentic_timer:close()
                        agentic_timer = nil
                        lualine.refresh()
                    end
                end)
            )
        end
    end
end

local function get_agentic_status()
    if vim.bo.filetype ~= "AgenticChat" then
        return ""
    end

    local ok, session_registry = pcall(require, "agentic.session_registry")
    if not ok then
        return ""
    end

    local tab_page_id = vim.api.nvim_get_current_tabpage()
    local session_manager = session_registry.get_session_for_tab_page(tab_page_id)
    if not session_manager then
        return ""
    end

    if session_manager.is_generating then
        start_agentic_timer()
        return utils.spinner_frames[agentic_spinner_index]
    end

    return utils.icons.ok
end

local function get_agentic_mode()
    if vim.bo.filetype ~= "AgenticChat" then
        return ""
    end

    local ok, session_registry = pcall(require, "agentic.session_registry")
    if not ok then
        return ""
    end

    local tab_page_id = vim.api.nvim_get_current_tabpage()
    local session_manager = session_registry.get_session_for_tab_page(tab_page_id)
    if not session_manager or not session_manager.agent_modes or not session_manager.agent_modes.current_mode_id then
        return ""
    end

    local mode = session_manager.agent_modes:get_mode(session_manager.agent_modes.current_mode_id)
    if mode then
        return mode.name
    end

    return ""
end

local separator_before_agentic_status = separator_if(function()
    return vim.bo.filetype == "AgenticChat"
end)

local separator_before_agentic_mode = separator_if(function()
    return vim.bo.filetype == "AgenticChat" and get_agentic_mode() ~= ""
end)

lualine.setup({
    options = {
        theme = theme,
        component_separators = { left = "", right = "" },
        section_separators = { left = "", right = "" },
    },
    sections = sections,
    inactive_sections = inactive_sections,
    extensions = {
        {
            filetypes = agentic_filetypes,
            sections = {
                lualine_a = {
                    {
                        get_agentic_title,
                        color = "StatusLineActiveItem",
                    },
                },
                lualine_b = {},
                lualine_c = {},
                lualine_x = {
                    separator_before_agentic_status,
                    {
                        get_agentic_status,
                        cond = function()
                            return vim.bo.filetype == "AgenticChat"
                        end,
                    },
                    separator_before_agentic_mode,
                    {
                        get_agentic_mode,
                        cond = function()
                            return vim.bo.filetype == "AgenticChat"
                        end,
                    },
                },
                lualine_y = {},
                lualine_z = {},
            },
            inactive_sections = {
                lualine_a = {
                    get_agentic_title,
                },
                lualine_b = {},
                lualine_c = {},
                lualine_x = {
                    separator_before_agentic_status,
                    {
                        get_agentic_status,
                        cond = function()
                            return vim.bo.filetype == "AgenticChat"
                        end,
                    },
                    separator_before_agentic_mode,
                    {
                        get_agentic_mode,
                        cond = function()
                            return vim.bo.filetype == "AgenticChat"
                        end,
                    },
                },
                lualine_y = {},
                lualine_z = {},
            },
        },
    },
})

local M = {}

function M.on_attach()
    lsp_attached = true
    lualine.refresh()
end

return M

