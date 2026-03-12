local md = require("sodium.markdown")

local function continue_list(key)
    return function()
        local line = vim.api.nvim_get_current_line()
        local prefix = md.get_list_prefix(line)
        if not prefix then
            return vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes(key, true, false, true), "n", false)
        end
        if not md.has_text_after_prefix(line) then
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
    local prefix = md.get_list_prefix(line)
    if not prefix then
        return vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<CR>", true, false, true), "n", false)
    end
    if not md.has_text_after_prefix(line) then
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

vim.api.nvim_create_user_command("InterviewNote", function()
    local date = os.date("%Y-%m-%d")
    local vault = vim.fn.expand("~/stripe/work")
    local template = vault .. "/Interview template.md"
    local target = vault .. "/" .. date .. "-interview.md"
    if vim.fn.filereadable(target) == 1 then
        vim.cmd.edit(target)
        return
    end
    local lines = vim.fn.readfile(template)
    vim.fn.writefile(lines, target)
    vim.cmd.edit(target)
end, {})

return {
    {
        "MeanderingProgrammer/render-markdown.nvim",
        dependencies = { "nvim-treesitter/nvim-treesitter", "nvim-tree/nvim-web-devicons" },
        opts = {
            nested = false,
            checkbox = {
                left_pad = 3,
                custom = {
                    todo = { raw = '[-]', rendered = '󰥔 ', highlight = 'RenderMarkdownTodo' },
                    progress = { raw = '[/]', rendered = '󰡖 ', highlight = 'RenderMarkdownTodo' },
                },
            },
            heading = {
                width = "block",
                left_pad = 1,
                right_pad = 1,
                position = "inline",
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
        "obsidian-nvim/obsidian.nvim",
        version = "*",
        lazy = true,
        ft = "markdown",
        keys = {
            {
                "<leader>ww",
                function()
                    vim.fn.system("work tick")
                    vim.cmd("Obsidian today")
                end,
            },
            {
                "<leader>w w",
                function()
                    local work_dir = vim.fn.expand("~/stripe/work")
                    local files = vim.fn.glob(work_dir .. "/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].md", false, true)
                    local items = {}
                    table.sort(files, function(a, b)
                        return a > b
                    end)
                    local items = {}
                    for _, file in ipairs(files) do
                        table.insert(items, { file = file, text = file })
                    end
                    Snacks.picker({
                        title = "Daily Notes",
                        items = items,
                        format = "file",
                        on_show = function()
                            vim.cmd.stopinsert()
                        end,
                    })
                end,
                desc = "Daily Notes",
            },
            { "<leader>wi", "<cmd>InterviewNote<cr>" },
        },
        dependencies = {
            "nvim-lua/plenary.nvim",
        },
        opts = {
            legacy_commands = false,
            workspaces = vim.fn.isdirectory(vim.fn.expand("~/stripe/work")) == 1
                and { { name = "work", path = "~/stripe/work" } }
                or {},
            completion = {
                blink = true,
                min_chars = 2,
            },
            callbacks = {
                enter_note = function()
                    vim.keymap.set("n", "gf", require("obsidian.api").smart_action, { buffer = true })
                    vim.keymap.set("n", "<CR>", require("obsidian.api").smart_action, { buffer = true })
                    vim.keymap.set("n", "<C-Space>", "<cmd>Obsidian toggle_checkbox<cr>", { buffer = true })
                end,
            },
            checkbox = {
                order = { " ", "/", "x" },
            },
            ui = {
                enable = false,
            },
        },
    },
}
