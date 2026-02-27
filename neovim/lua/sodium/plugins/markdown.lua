local function get_list_prefix(line)
    local indent = line:match("^(%s*)%- %[[ /xX]%] ")
    if indent then
        return indent .. "- [ ] "
    end
    local indent2, marker = line:match("^(%s*)([-*] )")
    if indent2 then
        return indent2 .. marker
    end
    local indent3, num, dot = line:match("^(%s*)(%d+)([.)]) ")
    if indent3 then
        return indent3 .. tostring(tonumber(num) + 1) .. dot .. " "
    end
    return nil
end

local function has_text_after_prefix(line)
    if line:match("^%s*%- %[.%] .+") then
        return true
    end
    if line:match("^%s*[-*] .+") then
        return true
    end
    if line:match("^%s*%d+[.)] .+") then
        return true
    end
    return false
end

local function continue_list(key)
    return function()
        local line = vim.api.nvim_get_current_line()
        local prefix = get_list_prefix(line)
        if not prefix then
            return vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes(key, true, false, true), "n", false)
        end
        if not has_text_after_prefix(line) then
            vim.api.nvim_set_current_line("")
            return
        end
        local row = vim.api.nvim_win_get_cursor(0)[1]
        if key == "o" then
            vim.api.nvim_buf_set_lines(0, row, row, false, { prefix })
            vim.api.nvim_win_set_cursor(0, { row + 1, #prefix })
            vim.cmd("startinsert!")
        elseif key == "O" then
            vim.api.nvim_buf_set_lines(0, row - 1, row - 1, false, { prefix })
            vim.api.nvim_win_set_cursor(0, { row, #prefix })
            vim.cmd("startinsert!")
        end
    end
end

local function cr_continue_list()
    local line = vim.api.nvim_get_current_line()
    local prefix = get_list_prefix(line)
    if not prefix then
        return vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<CR>", true, false, true), "n", false)
    end
    if not has_text_after_prefix(line) then
        vim.api.nvim_set_current_line("")
        return
    end
    local row = vim.api.nvim_win_get_cursor(0)[1]
    vim.api.nvim_buf_set_lines(0, row, row, false, { prefix })
    vim.api.nvim_win_set_cursor(0, { row + 1, #prefix })
end

vim.api.nvim_create_autocmd("FileType", {
    pattern = "markdown",
    callback = function(ev)
        vim.keymap.set("n", "o", continue_list("o"), { buffer = ev.buf })
        vim.keymap.set("n", "O", continue_list("O"), { buffer = ev.buf })
        vim.keymap.set("i", "<CR>", cr_continue_list, { buffer = ev.buf })
    end,
})

return {
    {
        "MeanderingProgrammer/render-markdown.nvim",
        dependencies = { "nvim-treesitter/nvim-treesitter", "nvim-tree/nvim-web-devicons" },
        opts = {
            heading = {
                width = "block",
                left_pad = 1,
                right_pad = 2,
                -- border = true,
                -- border_virtual = true,
            },
            code = {
                left_margin = 2,
                border = "thin",
                width = "block",
                language_pad = 2,
                left_pad = 2,
                right_pad = 2,
                inline = false,
            },
        },
    },
    {
        "epwalsh/obsidian.nvim",
        version = "*",
        lazy = true,
        ft = "markdown",
        keys = {
            { "<leader>ww", "<cmd>ObsidianToday<cr>" },
        },
        dependencies = {
            "nvim-lua/plenary.nvim",
        },
        opts = {
            workspaces = {
                {
                    name = "work",
                    path = "~/stripe/work",
                },
            },
            completion = {
                nvim_cmp = false,
                min_chars = 2,
            },
            mappings = {
                ["gf"] = {
                    action = function()
                        return require("obsidian").util.gf_passthrough()
                    end,
                    opts = { noremap = false, expr = true, buffer = true },
                },
                ["<C-Space>"] = {
                    action = function()
                        return require("obsidian").util.toggle_checkbox({ " ", "/", "x" })
                    end,
                    opts = { buffer = true },
                },
            },
            ui = {
                enable = false,
            },
        },
    },
}
