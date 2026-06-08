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

local function work_failure_message(result)
    local msg = "work tick failed (exit " .. result.code .. ")"
    local stderr = vim.trim(result.stderr or "")
    if stderr ~= "" then
        return msg .. "\n" .. stderr
    end

    local stdout = vim.trim(result.stdout or "")
    if stdout == "" then
        return msg
    end

    local lines = vim.split(stdout, "\n", { plain = true, trimempty = true })
    local first = math.max(#lines - 4, 1)
    return msg .. "\n" .. table.concat(vim.list_slice(lines, first, #lines), "\n")
end

vim.api.nvim_create_autocmd("FileType", {
    pattern = "markdown",
    callback = function(ev)
        vim.keymap.set("n", "o", continue_list("o"), { buf = ev.buf })
        vim.keymap.set("n", "O", continue_list("O"), { buf = ev.buf })
        vim.keymap.set("i", "<CR>", cr_continue_list, { buf = ev.buf })
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
            file_types = { "markdown", "AgenticChat" },
            ignore = function(buf)
                local bt = vim.bo[buf].buftype
                if bt == "" then
                    return false
                end
                if vim.bo[buf].filetype == "AgenticChat" then
                    return false
                end
                return true
            end,
            on = {
                render = function(ctx)
                    if vim.bo[ctx.buf].filetype ~= "AgenticChat" then
                        return
                    end
                    local all_ns = vim.api.nvim_get_namespaces()
                    local tool_ns = all_ns["agentic_tool_blocks"]
                    local rm_ns = all_ns["render-markdown.nvim"]
                    if tool_ns and rm_ns then
                        local blocks = vim.api.nvim_buf_get_extmarks(ctx.buf, tool_ns, 0, -1, { details = true })
                        for _, block in ipairs(blocks) do
                            local start_row = block[2]
                            local end_row = (block[4] and block[4].end_row) or start_row
                            local marks = vim.api.nvim_buf_get_extmarks(
                                ctx.buf,
                                rm_ns,
                                { start_row, 0 },
                                { end_row, -1 },
                                {}
                            )
                            for _, mark in ipairs(marks) do
                                vim.api.nvim_buf_del_extmark(ctx.buf, rm_ns, mark[1])
                            end
                        end
                    end
                    local diff_ns = all_ns["agentic_diff_highlights"]
                    if diff_ns then
                        local marks = vim.api.nvim_buf_get_extmarks(ctx.buf, diff_ns, 0, -1, { details = true })
                        for _, mark in ipairs(marks) do
                            if mark[4] and mark[4].hl_group == "Comment" then
                                vim.api.nvim_buf_del_extmark(ctx.buf, diff_ns, mark[1])
                            end
                        end
                    end
                end,
            },
            nested = false,
            checkbox = {
                left_pad = 3,
                custom = {
                    todo = { raw = "[-]", rendered = "󰥔 ", highlight = "RenderMarkdownTodo" },
                    progress = { raw = "[/]", rendered = "󰡖 ", highlight = "RenderMarkdownTodo" },
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
                    local work_bin = vim.env.HOME .. "/.dotfiles/work-cli/bin/work"
                    local spin = require("sodium.spinner")
                    spin.start("work")
                    vim.fn.system({ work_bin, "ensure" })
                    vim.cmd("Obsidian today")
                    vim.system({ work_bin, "tick" }, { text = true }, function(r)
                        vim.schedule(function()
                            spin.stop("work")
                            vim.cmd("checktime")
                            if r.code ~= 0 then
                                vim.notify(work_failure_message(r), vim.log.levels.WARN)
                            end
                        end)
                    end)
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
            {
                "<leader>wp",
                function()
                    local work_dir = vim.fn.expand("~/stripe/work")
                    local bufname = vim.fn.fnamemodify(vim.api.nvim_buf_get_name(0), ":t")
                    local ref = bufname:match("^(%d%d%d%d%-%d%d%-%d%d)%.md$") or os.date("%Y-%m-%d")
                    local files = vim.fn.glob(work_dir .. "/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].md", false, true)
                    table.sort(files, function(a, b)
                        return a > b
                    end)
                    for _, file in ipairs(files) do
                        local date = vim.fn.fnamemodify(file, ":t"):match("^(%d%d%d%d%-%d%d%-%d%d)%.md$")
                        if date and date < ref then
                            vim.cmd("edit " .. vim.fn.fnameescape(file))
                            return
                        end
                    end
                    vim.notify("No previous daily note", vim.log.levels.WARN)
                end,
                desc = "Previous Daily Note",
            },
        },
        dependencies = {
            "nvim-lua/plenary.nvim",
        },
        opts = {
            legacy_commands = false,
            workspaces = vim.fn.isdirectory(vim.fn.expand("~/stripe/work")) == 1 and {
                { name = "work", path = "~/stripe/work" },
            } or {},
            completion = {
                blink = true,
                min_chars = 2,
            },
            callbacks = {
                enter_note = function()
                    local api = require("obsidian.api")
                    local function follow_link_or(fallback)
                        return function()
                            if api.cursor_link() then
                                vim.cmd("Obsidian follow_link")
                                return
                            end
                            local url = vim.fn.expand("<cWORD>"):match("https?://[%w_.~!*'();:@&=+$,/?#%[%]%%%-]+")
                            if url then
                                vim.ui.open(url)
                            else
                                fallback()
                            end
                        end
                    end
                    vim.keymap.set(
                        "n",
                        "gf",
                        follow_link_or(function()
                            vim.cmd("normal! gF")
                        end),
                        { buf = 0 }
                    )
                    vim.keymap.set(
                        "n",
                        "<CR>",
                        follow_link_or(function()
                            if api.cursor_checkbox() then
                                vim.cmd("Obsidian toggle_checkbox")
                                vim.cmd("write")
                            end
                        end),
                        { buf = 0 }
                    )
                    vim.keymap.set("n", "<C-Space>", function()
                        vim.cmd("Obsidian toggle_checkbox")
                        vim.cmd("write")
                    end, { buf = 0 })
                    vim.keymap.set("v", "<C-Space>", function()
                        local start_line = vim.fn.line("v")
                        local end_line = vim.fn.line(".")
                        if start_line > end_line then
                            start_line, end_line = end_line, start_line
                        end
                        vim.cmd("normal! " .. vim.api.nvim_replace_termcodes("<Esc>", true, false, true))
                        for lnum = start_line, end_line do
                            vim.api.nvim_win_set_cursor(0, { lnum, 0 })
                            vim.cmd("Obsidian toggle_checkbox")
                        end
                        vim.cmd("write")
                        vim.cmd("normal! gv")
                    end, { buf = 0 })
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

