local lualine = require("lualine")
local utils = require("sodium.utils")
local spinner = require("sodium.spinner")

local non_standard_filetypes = { "", "Trouble", "vimwiki", "help" }
local agentic_filetypes = { "AgenticChat", "AgenticInput", "AgenticCode", "AgenticFiles", "AgenticTodos" }

local lsp_attached = false
local M = {}

local function is_standard_filetype()
    local ft = vim.bo.filetype
    for _, filetype in ipairs(non_standard_filetypes) do
        if ft == nil or ft == filetype then
            return false
        end
    end
    return true
end

function M.get_filename()
    local bufname = vim.api.nvim_buf_get_name(0)
    local _, _, filepath = bufname:match("^fugitive://(.+)//(%x+)/(.+)$")
    if filepath then
        return "[staged]: " .. filepath
    end
    return vim.fn.fnamemodify(bufname, ":~:.")
end

local filename_active = {
    M.get_filename,
    cond = is_standard_filetype,
    color = "StatusLineActiveItem",
}

local filename_inactive = {
    M.get_filename,
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

local original_progress_handler = vim.lsp.handlers["$/progress"]

---@diagnostic disable-next-line: duplicate-set-field
vim.lsp.handlers["$/progress"] = function(err, msg, info)
    if original_progress_handler then
        original_progress_handler(err, msg, info)
    end
    local key = "lsp:" .. info.client_id .. ":" .. tostring(msg.token)
    if msg.value.kind == "end" then
        spinner.stop(key)
    else
        spinner.start(key)
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

local function diagnostics_component()
    local bufnr = 0
    local error_count = #vim.diagnostic.get(bufnr, { severity = vim.diagnostic.severity.ERROR })
    local warn_count = #vim.diagnostic.get(bufnr, { severity = vim.diagnostic.severity.WARN })
    local info_count = #vim.diagnostic.get(bufnr, { severity = vim.diagnostic.severity.INFO })
    local hint_count = #vim.diagnostic.get(bufnr, { severity = vim.diagnostic.severity.HINT })

    local status_parts = {}
    if error_count > 0 then
        table.insert(status_parts, { text = utils.icons.Error .. " " .. error_count, color = "StatusLineError" })
    end
    if warn_count > 0 then
        table.insert(status_parts, { text = utils.icons.Warn .. " " .. warn_count, color = "StatusLineWarning" })
    end
    if info_count > 0 then
        table.insert(status_parts, { text = utils.icons.Info .. " " .. info_count, color = "StatusLine" })
    end
    if hint_count > 0 then
        table.insert(status_parts, { text = utils.icons.Hint .. " " .. hint_count, color = "StatusLine" })
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

local function separator_if(cond_fn)
    return {
        function()
            return "│"
        end,
        cond = cond_fn,
        color = "StatusLineSeparator",
        padding = 0,
    }
end

local separator = separator_if(is_standard_filetype)

local separator_after_lsp_or_review = separator_if(function()
    if not is_standard_filetype() then
        return false
    end
    local ok, review = pcall(require, "sodium.review")
    if ok and review.get_current_pr() then
        return false
    end
    return true
end)

local function pr_review_component()
    local ok, review = pcall(require, "sodium.review")
    if not ok then
        return ""
    end
    local pr = review.get_current_pr()
    if not pr then
        return ""
    end
    return "PR #" .. pr.number
end

local pr_review = {
    pr_review_component,
    cond = function()
        local ok, review = pcall(require, "sodium.review")
        if not ok then
            return false
        end
        return is_standard_filetype() and review.get_current_pr() ~= nil
    end,
    color = "StatusLineActiveItem",
    padding = 1,
}

local spinner_component = {
    function()
        return spinner.frame()
    end,
    cond = function()
        return spinner.active() and is_standard_filetype()
    end,
    padding = 1,
}

local separator_before_status = separator_if(function()
    if not is_standard_filetype() then
        return false
    end
    if spinner.active() then
        return true
    end
    return lsp_attached and not utils.is_fugitive_buffer() and #vim.lsp.get_clients({ bufnr = 0 }) > 0
end)

local diagnostics = {
    diagnostics_component,
    cond = function()
        return not spinner.active()
            and lsp_attached
            and is_standard_filetype()
            and not utils.is_fugitive_buffer()
            and #vim.lsp.get_clients({ bufnr = 0 }) > 0
    end,
    padding = 1,
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
    lualine_x = {
        pr_review,
        separator_before_status,
        spinner_component,
        diagnostics,
        separator_after_lsp_or_review,
        lines,
        separator,
        column,
    },
    lualine_y = {},
    lualine_z = {},
}

local inactive_sections = {
    lualine_a = { filename_inactive },
    lualine_b = {},
    lualine_c = {},
    lualine_x = {
        pr_review,
        separator_before_status,
        spinner_component,
        diagnostics,
        separator_after_lsp_or_review,
        lines,
        separator,
        column,
    },
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

function M.get_agentic_title()
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
        spinner.start("agentic")
        return spinner.frame()
    end
    spinner.stop("agentic")
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
                        M.get_agentic_title,
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
                    M.get_agentic_title,
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

function M.on_attach()
    lsp_attached = true
    lualine.refresh()
end

return M
