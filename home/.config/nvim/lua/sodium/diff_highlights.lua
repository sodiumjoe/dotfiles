local M = {}

function M.apply_diff_mode(p)
    vim.api.nvim_set_hl(0, "DiffAdd", { bg = nil })
    vim.api.nvim_set_hl(0, "DiffChange", { bg = nil })
    vim.api.nvim_set_hl(0, "DiffDelete", { fg = p.bg2, bg = p.bg2 })
    vim.api.nvim_set_hl(0, "DiffText", { bg = p.bg2 })
    vim.api.nvim_set_hl(0, "DiffTextAdd", { bg = p.bg2 })
end

function M.restore(p, git)
    vim.api.nvim_set_hl(0, "DiffAdd", { fg = p.bg1, bg = git.add })
    vim.api.nvim_set_hl(0, "DiffChange", { fg = p.bg1, bg = git.changed })
    vim.api.nvim_set_hl(0, "DiffDelete", { fg = p.bg1, bg = git.removed })
    vim.api.nvim_set_hl(0, "DiffText", { fg = p.bg1, bg = p.yellow })
    vim.api.nvim_set_hl(0, "DiffTextAdd", { fg = p.bg1, bg = p.green })
end

function M.sign_group(name)
    if name == "DiffAdd" or name == "DiffTextAdd" then
        return "DiffSignAdd"
    end
    if name == "DiffChange" or name == "DiffText" then
        return "DiffSignChange"
    end
    if name == "DiffDelete" then
        return "DiffSignDelete"
    end
end

return M
