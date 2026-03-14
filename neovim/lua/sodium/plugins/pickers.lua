return {
    "folke/snacks.nvim",
    priority = 1000,
    lazy = false,
    opts = {
        picker = {
            main = {
                file = false,
                current = true,
            },
            prompt = "❯ ",
            reverse = true,
            layout = {
                reverse = true,
                layout = {
                    box = "horizontal",
                    backdrop = false,
                    width = 0.9,
                    height = 0.9,
                    border = "none",
                    {
                        box = "vertical",
                        { win = "list", title = " Results ", title_pos = "center", border = "rounded" },
                        {
                            win = "input",
                            height = 1,
                            border = "rounded",
                            title = "{title} {live} {flags}",
                            title_pos = "center",
                        },
                    },
                    {
                        win = "preview",
                        title = "{preview:Preview}",
                        width = 0.5,
                        border = "rounded",
                        title_pos = "center",
                    },
                },
            },
            previewers = {
                diff = {
                    style = "syntax",
                },
            },
        },
        quickfile = { enabled = true },
        scroll = { enabled = true },
        notifier = {
            enabled = true,
            top_down = false,
            style = "fancy",
        },
    },
    keys = {
        {
            "<leader>sb",
            function()
                Snacks.picker.buffers({
                    on_show = function()
                        vim.cmd.stopinsert()
                    end,
                    current = false,
                })
            end,
            desc = "Buffers",
        },
        {
            "<leader>/",
            function()
                Snacks.picker.grep({ hidden = true })
            end,
            desc = "Grep",
        },
        {
            "<leader><Space>/",
            function()
                Snacks.picker.grep({ dirs = { vim.fn.expand("%:h") }, hidden = true })
            end,
            desc = "Grep cwd",
        },
        {
            "<leader>:",
            function()
                Snacks.picker.command_history({
                    on_show = function()
                        vim.cmd.stopinsert()
                    end,
                })
            end,
            desc = "Command History",
        },
        {
            "<C-p>",
            function()
                Snacks.picker.files({ hidden = true })
            end,
            desc = "Find Files",
        },
        {
            "<leader>8",
            function()
                Snacks.picker.grep_word({
                    hidden = true,
                    on_show = function()
                        vim.cmd.stopinsert()
                    end,
                })
            end,
            desc = "Find Files",
        },
        {
            "<leader>g",
            function()
                Snacks.picker.git_status({
                    on_show = function()
                        vim.cmd.stopinsert()
                    end,
                })
            end,
            desc = "Git Status",
        },
        {
            '<leader>s"',
            function()
                Snacks.picker.registers()
            end,
            desc = "Registers",
        },
        {
            "<leader>sa",
            function()
                Snacks.picker.autocmds()
            end,
            desc = "Autocmds",
        },
        {
            "<leader>sc",
            function()
                Snacks.picker.command_history()
            end,
            desc = "Command History",
        },
        {
            "<leader>sC",
            function()
                Snacks.picker.commands()
            end,
            desc = "Commands",
        },
        {
            "<leader>sd",
            function()
                Snacks.picker.diagnostics({
                    on_show = function()
                        vim.cmd.stopinsert()
                    end,
                })
            end,
            desc = "Diagnostics",
        },
        {
            "<leader>sh",
            function()
                Snacks.picker.help()
            end,
            desc = "Help Pages",
        },
        {
            "<leader>sH",
            function()
                Snacks.picker.highlights()
            end,
            desc = "Highlights",
        },
        {
            "<leader>sj",
            function()
                Snacks.picker.jumps()
            end,
            desc = "Jumps",
        },
        {
            "<leader>sk",
            function()
                Snacks.picker.keymaps()
            end,
            desc = "Keymaps",
        },
        {
            "<leader>sl",
            function()
                Snacks.picker.loclist()
            end,
            desc = "Location List",
        },
        {
            "<leader>sM",
            function()
                Snacks.picker.man()
            end,
            desc = "Man Pages",
        },
        {
            "<leader>sm",
            function()
                Snacks.picker.marks()
            end,
            desc = "Marks",
        },
        {
            "<leader>r",
            function()
                Snacks.picker.resume({
                    on_show = function()
                        vim.cmd.stopinsert()
                    end,
                })
            end,
            desc = "Resume",
        },
        {
            "<leader>sq",
            function()
                Snacks.picker.qflist()
            end,
            desc = "Quickfix List",
        },
        {
            "gd",
            function()
                Snacks.picker.lsp_definitions()
            end,
            desc = "Goto Definition",
        },
        {
            "gr",
            function()
                Snacks.picker.lsp_references()
            end,
            nowait = true,
            desc = "References",
        },
        {
            "<leader>sp",
            function()
                local plans_dir = vim.fn.expand("~/.claude/plans")
                local all_files = vim.fn.glob(plans_dir .. "/*.md", false, true)
                local items = {}
                for _, file in ipairs(all_files) do
                    local mtime = vim.fn.getftime(file)
                    table.insert(items, { file = file, text = file, mtime = mtime })
                end
                table.sort(items, function(a, b)
                    return a.mtime > b.mtime
                end)
                Snacks.picker({
                    items = items,
                    format = "file",
                    on_show = function()
                        vim.cmd.stopinsert()
                    end,
                })
            end,
            desc = "Claude Plans",
        },
        {
            "<leader>sP",
            function()
                local projects_dir = vim.env.HOME .. "/stripe/work/projects"
                local files = vim.fn.glob(projects_dir .. "/*.md", false, true)
                local items = {}
                for _, file in ipairs(files) do
                    if not file:match("_template%.md$") then
                        local mtime = vim.fn.getftime(file)
                        table.insert(items, { file = file, text = file, mtime = mtime })
                    end
                end
                table.sort(items, function(a, b)
                    return a.mtime > b.mtime
                end)
                Snacks.picker({
                    items = items,
                    format = "file",
                    on_show = function()
                        vim.cmd.stopinsert()
                    end,
                })
            end,
            desc = "Projects",
        },
    },
}
