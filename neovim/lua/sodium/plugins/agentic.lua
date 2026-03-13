local work_bin = vim.env.HOME .. "/stripe/work/personal-marketplace/work/bin/work"
local projects_dir = vim.env.HOME .. "/stripe/work/projects/"
local agentic_utils = require("sodium.agentic_utils")

local agentic_filetypes = { "AgenticChat", "AgenticInput", "AgenticCode", "AgenticFiles", "AgenticTodos" }

local function resize_agentic_split()
    local target = math.floor(vim.o.lines * 0.5)
    for _, win in ipairs(vim.api.nvim_list_wins()) do
        local buf = vim.api.nvim_win_get_buf(win)
        local ft = vim.bo[buf].filetype
        if vim.tbl_contains(agentic_filetypes, ft) then
            vim.api.nvim_win_set_height(win, target)
            return
        end
    end
end

local function start_project_session(proj)
    local Config = require("agentic.config")
    local AgentInstance = require("agentic.acp.agent_instance")
    local SessionRegistry = require("agentic.session_registry")

    local provider = Config.provider or "claude-acp"
    local instance = AgentInstance._instances[provider]
    if instance then
        SessionRegistry.destroy_session()
        pcall(function()
            instance:stop()
        end)
        AgentInstance._instances[provider] = nil
    end

    Config.acp_providers[provider].env.CLAUDE_PROJECT = proj

    if proj and proj ~= "" then
        vim.fn.system(string.format("tmux label '%s' 2>/dev/null || true", proj))
    end

    require("agentic").new_session({ auto_add_to_context = false })
end

local function pick_project()
    vim.system({ work_bin, "list-projects" }, { text = true }, function(result)
        vim.schedule(function()
            local items = {}
            for line in (result.stdout or ""):gmatch("[^\n]+") do
                local slug, title, status = line:match("^(.-)\t(.-)\t(.-)$")
                if slug then
                    items[#items + 1] = {
                        text = title,
                        slug = slug,
                        status = status,
                        file = projects_dir .. slug .. ".md",
                    }
                end
            end

            table.sort(items, function(a, b)
                return a.text:lower() < b.text:lower()
            end)

            for i, item in ipairs(items) do
                item.sort_idx = i
            end

            Snacks.picker({
                title = "Projects",
                items = items,
                sort = function(a, b)
                    if a.score ~= b.score then return a.score > b.score end
                    return a.sort_idx < b.sort_idx
                end,
                preview = "file",
                format = function(item)
                    local ret = { { item.text } }
                    if item.status == "evergreen" then
                        ret[#ret + 1] = { " (evergreen)", "SnacksPickerDir" }
                    end
                    return ret
                end,
                on_show = function()
                    vim.cmd.stopinsert()
                end,
                confirm = function(picker, item)
                    if not item then return end
                    picker:close()
                    local editor_win = require("sodium.utils").editor_window()
                    if editor_win then
                        vim.api.nvim_set_current_win(editor_win)
                    end
                    vim.cmd.edit(item.file)
                    start_project_session(item.slug)
                end,
            })
        end)
    end)
end

local function new_project()
    vim.ui.input({ prompt = "Project title: " }, function(title)
        if not title or title == "" then
            return
        end
        local slug = agentic_utils.slugify(title)
        vim.system({ work_bin, "create-project", slug, title }, { text = true }, function(result)
            vim.schedule(function()
                if result.code ~= 0 then
                    vim.notify("create-project failed: " .. (result.stderr or ""), vim.log.levels.ERROR)
                    return
                end
                local project_file = projects_dir .. slug .. ".md"
                vim.cmd.edit(project_file)
                start_project_session(slug)
            end)
        end)
    end)
end

local function show_task_picker(items, show_project)
    for i, item in ipairs(items) do
        item.sort_idx = i
    end

    Snacks.picker({
        title = show_project and "All Tasks" or "Tasks",
        items = items,
        sort = function(a, b)
            if a.score ~= b.score then return a.score > b.score end
            return a.sort_idx < b.sort_idx
        end,
        preview = "file",
        format = function(item)
            local ret = { { agentic_utils.state_display[item.state] .. " ", item.state == "/" and "SnacksPickerLabel" or item.state == "x" and "SnacksPickerComment" or "SnacksPickerDir" } }
            ret[#ret + 1] = { item.description }
            if show_project then
                ret[#ret + 1] = { " (" .. item.title .. ")", "SnacksPickerDir" }
            end
            return ret
        end,
        on_show = function()
            vim.cmd.stopinsert()
        end,
        confirm = function(picker, item)
            if not item then return end
            picker:close()
            local editor_win = require("sodium.utils").editor_window()
            if editor_win then
                vim.api.nvim_set_current_win(editor_win)
            end
            vim.cmd.edit(item.file)
            vim.api.nvim_win_set_cursor(0, { item.line_num, 0 })
        end,
        win = {
            input = {
                keys = {
                    ["<Tab>"] = { "cycle_state", mode = { "n", "i" } },
                },
            },
        },
        actions = {
            cycle_state = function(picker)
                local item = picker:current()
                if not item then return end
                local next_state = agentic_utils.state_cycle[item.state]
                if not next_state then return end
                vim.system(
                    { work_bin, "set-task-state", item.file, tostring(item.line_num), next_state },
                    { text = true },
                    function(result)
                        vim.schedule(function()
                            if result.code == 0 then
                                item.state = agentic_utils.state_char[next_state]
                                local bufnr = vim.fn.bufnr(item.file)
                                if bufnr ~= -1 then
                                    local lnum = item.line_num - 1
                                    local f = io.open(item.file, "r")
                                    if f then
                                        local disk_line
                                        for _ = 1, item.line_num do
                                            disk_line = f:read("*l")
                                        end
                                        f:close()
                                        if disk_line then
                                            vim.api.nvim_buf_set_lines(bufnr, lnum, lnum + 1, false, { disk_line })
                                            vim.bo[bufnr].modified = false
                                        end
                                    end
                                end
                            end
                            picker.list:update({ force = true })
                        end)
                    end
                )
            end,
        },
    })
end

local function pick_task_state()
    local bufname = vim.api.nvim_buf_get_name(0)
    local project_file = nil

    if bufname:match(projects_dir .. ".*%.md$") then
        project_file = bufname
    else
        for _, buf in ipairs(vim.api.nvim_list_bufs()) do
            if vim.api.nvim_buf_is_loaded(buf) then
                local name = vim.api.nvim_buf_get_name(buf)
                if name:match(projects_dir .. ".*%.md$") then
                    project_file = name
                    break
                end
            end
        end
    end

    if project_file then
        vim.system({ work_bin, "list-tasks", project_file }, { text = true }, function(result)
            vim.schedule(function()
                show_task_picker(agentic_utils.parse_task_items(result.stdout), false)
            end)
        end)
    else
        vim.system({ work_bin, "list-projects" }, { text = true }, function(result)
            vim.schedule(function()
                local items = {}
                for line in (result.stdout or ""):gmatch("[^\n]+") do
                    local slug, title, status = line:match("^(.-)\t(.-)\t(.-)$")
                    if slug then
                        items[#items + 1] = {
                            text = title,
                            slug = slug,
                            status = status,
                            file = projects_dir .. slug .. ".md",
                        }
                    end
                end
                Snacks.picker({
                    title = "Select Project",
                    items = items,
                    format = function(item)
                        local ret = { { item.text } }
                        if item.status == "evergreen" then
                            ret[#ret + 1] = { " (evergreen)", "SnacksPickerDir" }
                        end
                        return ret
                    end,
                    on_show = function()
                        vim.cmd.stopinsert()
                    end,
                    confirm = function(picker, item)
                        if not item then return end
                        picker:close()
                        vim.system({ work_bin, "list-tasks", item.file }, { text = true }, function(r)
                            vim.schedule(function()
                                show_task_picker(agentic_utils.parse_task_items(r.stdout), false)
                            end)
                        end)
                    end,
                })
            end)
        end)
    end
end

local function pick_all_tasks()
    vim.system({ work_bin, "list-tasks" }, { text = true }, function(result)
        vim.schedule(function()
            show_task_picker(agentic_utils.parse_task_items(result.stdout), true)
        end)
    end)
end

local function add_task_finish(file, title, description)
    vim.system({ work_bin, "append-task", file, description }, {}, function(r)
        vim.schedule(function()
            if r.code ~= 0 then
                vim.notify("Failed to add task", vim.log.levels.ERROR)
                return
            end
            local editor_win = require("sodium.utils").editor_window()
            if editor_win then
                vim.api.nvim_set_current_win(editor_win)
            end
            local bufnr = vim.fn.bufnr(file)
            if bufnr ~= -1 then
                vim.api.nvim_buf_call(bufnr, function() vim.cmd("edit") end)
            else
                vim.cmd.edit(file)
            end
            vim.system({ work_bin, "tick" }, { text = true }, function(r)
                if r.code ~= 0 then
                    vim.schedule(function()
                        local msg = "work tick failed (exit " .. r.code .. ")"
                        if r.stderr and r.stderr ~= "" then
                            msg = msg .. "\n" .. vim.trim(r.stderr)
                        end
                        vim.notify(msg, vim.log.levels.WARN)
                    end)
                end
            end)
            vim.notify("Added task to " .. title, vim.log.levels.INFO)
        end)
    end)
end

local function add_task()
    vim.system({ work_bin, "list-projects" }, { text = true }, function(result)
        vim.schedule(function()
            local projects = { { text = "[New Project]", title = "[New Project]", slug = nil, file = nil } }

            for line in (result.stdout or ""):gmatch("[^\n]+") do
                local slug, title = line:match("^(.-)\t(.-)\t")
                if slug and slug ~= "" then
                    table.insert(projects, {
                        text = title,
                        title = title,
                        slug = slug,
                        file = projects_dir .. slug .. ".md",
                    })
                end
            end

            Snacks.picker({
                title = "Select Project",
                items = projects,
                format = function(item)
                    return { { item.title } }
                end,
                on_show = function()
                    vim.cmd.startinsert()
                end,
                confirm = function(picker, item)
                    if not item then return end
                    picker:close()
                    if item.slug then
                        vim.ui.input({ prompt = "Task: " }, function(description)
                            if not description or description == "" then return end
                            add_task_finish(item.file, item.title, description)
                        end)
                    else
                        vim.ui.input({ prompt = "Project title: " }, function(title)
                            if not title or title == "" then return end
                            local slug = agentic_utils.slugify(title)
                            vim.system({ work_bin, "create-project", slug, title }, { text = true }, function(cr)
                                vim.schedule(function()
                                    if cr.code ~= 0 then
                                        vim.notify(
                                            "create-project failed: " .. (cr.stderr or ""),
                                            vim.log.levels.ERROR
                                        )
                                        return
                                    end
                                    local file = projects_dir .. slug .. ".md"
                                    vim.ui.input({ prompt = "Task: " }, function(description)
                                        if not description or description == "" then return end
                                        add_task_finish(file, title, description)
                                    end)
                                end)
                            end)
                        end)
                    end
                end,
            })
        end)
    end)
end

return {
    "carlos-algms/agentic.nvim",
    cond = function()
        local claude_path = vim.fn.resolve(vim.fn.exepath("claude"))
        return vim.fn.executable(claude_path) == 1 or vim.fn.executable("gemini") == 1
    end,
    config = function()
        local utils = require("sodium.utils")
        local diagnostics = require("sodium.config.diagnostics")
        local claude_path = vim.fn.resolve(vim.fn.exepath("claude"))

        local agentic_modified_files = {}
        local agentic_tracking_augroup = vim.api.nvim_create_augroup("AgenticFileTracking", { clear = true })

        local function start_tracking_agentic_writes()
            vim.api.nvim_create_autocmd("BufWritePost", {
                group = agentic_tracking_augroup,
                callback = function(args)
                    local filepath = vim.api.nvim_buf_get_name(args.buf)
                    if filepath ~= "" and not utils.is_fugitive_buffer(args.buf) then
                        agentic_modified_files[filepath] = true
                    end
                end,
            })
        end

        local function stop_tracking_agentic_writes()
            vim.api.nvim_clear_autocmds({ group = agentic_tracking_augroup })
        end

        local function format_modified_files()
            for filepath, _ in pairs(agentic_modified_files) do
                local bufnr = vim.fn.bufnr(filepath)
                if bufnr ~= -1 and vim.api.nvim_buf_is_loaded(bufnr) then
                    vim.lsp.buf.format({ bufnr = bufnr, timeout_ms = 30000 })
                end
            end
            agentic_modified_files = {}
        end

        local function noop()
            return ""
        end

        require("agentic").setup({
            image_paste = {
                enabled = false,
            },
            file_picker = {
                enabled = false,
            },
            provider = vim.fn.executable("claude") == 1 and "claude-acp" or "gemini-acp",
            acp_providers = {
                ["claude-acp"] = {
                    env = {
                        NODE_NO_WARNINGS = "1",
                        IS_AI_TERMINAL = "1",
                        NODENV_VERSION = "24.13.0",
                        CLAUDE_CODE_EXECUTABLE = claude_path,
                        NVIM = vim.v.servername,
                    },
                    default_mode = "plan",
                },
                ["gemini-acp"] = {
                    command = "gemini",
                    args = { "--experimental-acp" },
                    env = {},
                },
            },
            windows = {
                height = 0.5,
                position = "bottom",
                code = diagnostics.window_opts,
                files = diagnostics.window_opts,
                input = diagnostics.window_opts,
                todos = diagnostics.window_opts,
                chat = diagnostics.window_opts,
            },
            headers = {
                chat = noop,
                input = noop,
                code = noop,
                files = noop,
                todos = noop,
            },
            hooks = {
                on_prompt_submit = function()
                    start_tracking_agentic_writes()
                end,
                on_response_complete = function()
                    vim.schedule(function()
                        stop_tracking_agentic_writes()
                        format_modified_files()
                    end)
                end,
            },
        })

        utils.augroup("AgenticResize", { clear = true })("VimResized", {
            callback = resize_agentic_split,
        })
    end,
    keys = {
        {
            "<leader>ac",
            function()
                require("agentic").toggle()
            end,
            mode = { "n" },
            desc = "Toggle Agentic Chat",
        },
        {
            "<leader>aa",
            function()
                require("agentic").add_selection_or_file_to_context()
            end,
            mode = { "n", "v" },
            desc = "Add file or selection to Agentic to Context",
        },
        {
            "<leader>ao",
            function()
                require("agentic").open()
            end,
            mode = { "n" },
            desc = "Open Agentic Chat",
        },
        {
            "<leader>an",
            function()
                require("agentic").new_session()
            end,
            mode = { "n" },
            desc = "New Agentic Chat session",
        },
        {
            "<leader>ar",
            function()
                require("agentic").restore_session()
            end,
            mode = { "n" },
            desc = "Restore Agentic Chat session",
        },
        {
            "<leader>ad",
            function()
                require("agentic").add_current_line_diagnostics()
            end,
            desc = "Add current line diagnostic to Agentic",
            mode = { "n" },
        },
        {
            "<leader>aD",
            function()
                require("agentic").add_buffer_diagnostics()
            end,
            desc = "Add all buffer diagnostics to Agentic",
            mode = { "n" },
        },
        {
            "<leader>ap",
            pick_project,
            mode = { "n" },
            desc = "Pick project and start Agentic session",
        },
        {
            "<leader>aP",
            new_project,
            mode = { "n" },
            desc = "Create project and start Agentic session",
        },
        {
            "<leader>at",
            add_task,
            mode = { "n" },
            desc = "Add task to project",
        },
        {
            "<leader>st",
            pick_task_state,
            mode = { "n" },
            desc = "Task state picker (context-aware)",
        },
        {
            "<leader>sT",
            pick_all_tasks,
            mode = { "n" },
            desc = "Task state picker (all projects)",
        },
        {
            "<leader>a=",
            resize_agentic_split,
            mode = { "n" },
            desc = "Rebalance agentic split to 50%",
        },
    },
}
