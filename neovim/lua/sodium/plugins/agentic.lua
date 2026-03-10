local work_bin = vim.env.HOME .. "/stripe/work/personal-marketplace/work/bin/work"
local projects_dir = vim.env.HOME .. "/stripe/work/projects/"

local function start_project_session(proj, task)
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
    Config.acp_providers[provider].env.CLAUDE_TASK = task

    if proj and proj ~= "" then
        vim.fn.system(string.format("tmux label '%s' 2>/dev/null || true", proj))
    end

    require("agentic").new_session({ auto_add_to_context = false })
end

local function pick_task()
    vim.system({ work_bin, "gather" }, {}, function()
        vim.system({ work_bin, "scan" }, { text = true }, function(result)
            vim.schedule(function()
                local raw = {}
                for line in (result.stdout or ""):gmatch("[^\n]+") do
                    local _file, name, desc, _kind, state, slug = line:match("^(.-)\t(.-)\t(.-)\t(.-)\t(.)\t(.-)$")
                    if slug and desc then
                        raw[#raw + 1] = {
                            state = state,
                            text = desc,
                            proj = slug,
                            name = name,
                            file = slug ~= "" and (projects_dir .. slug .. ".md") or nil,
                        }
                    end
                end

                table.sort(raw, function(a, b)
                    local ap = a.proj == "" and "\xff" or a.proj:lower()
                    local bp = b.proj == "" and "\xff" or b.proj:lower()
                    if ap ~= bp then return ap < bp end
                    return (a.text or "") < (b.text or "")
                end)

                for i, item in ipairs(raw) do
                    item.sort_idx = i
                end

                Snacks.picker({
                    title = "Work Queue",
                    items = raw,
                    sort = function(a, b)
                        if a.score ~= b.score then return a.score > b.score end
                        return a.sort_idx < b.sort_idx
                    end,
                    preview = function(ctx)
                        if ctx.item.file then
                            return Snacks.picker.preview.file(ctx)
                        end
                        ctx.preview:reset()
                        ctx.preview:set_lines({ "(no project)" })
                    end,
                    format = function(item, _ctx)
                        local status = item.state == "/" and "/ " or "  "
                        local ret = { { status, item.state == "/" and "SnacksPickerIdx" or nil } }
                        ret[#ret + 1] = { item.text }
                        if item.proj ~= "" then
                            ret[#ret + 1] = { " 󱃶 " .. (item.name or item.proj), "SnacksPickerDir" }
                        end
                        return ret
                    end,
                    on_show = function()
                        vim.cmd.stopinsert()
                    end,
                    confirm = function(picker, item)
                        if not item then return end
                        picker:close()
                        if item.file then
                            local editor_win = require("sodium.utils").editor_window()
                            if editor_win then
                                vim.api.nvim_set_current_win(editor_win)
                            end
                            vim.cmd.edit(item.file)
                        end
                        start_project_session(item.proj, item.text)
                    end,
                })
            end)
        end)
    end)
end

local function new_project()
    vim.ui.input({ prompt = "Project title: " }, function(title)
        if not title or title == "" then
            return
        end
        local slug = title:lower():gsub("[^%w]+", "-"):gsub("^-+", ""):gsub("-+$", "")
        vim.system({ work_bin, "create-project", slug, title }, { text = true }, function(result)
            vim.schedule(function()
                if result.code ~= 0 then
                    vim.notify("create-project failed: " .. (result.stderr or ""), vim.log.levels.ERROR)
                    return
                end
                local project_file = projects_dir .. slug .. ".md"
                vim.cmd.edit(project_file)
                start_project_session(slug, title)
            end)
        end)
    end)
end

local function add_task()
    vim.ui.input({ prompt = "Task: " }, function(description)
        if not description or description == "" then
            return
        end

        vim.system({ work_bin, "scan" }, { text = true }, function(result)
            vim.schedule(function()
                local projects_seen = {}
                local projects = { { title = "[New Project]", slug = nil, file = nil } }

                for line in (result.stdout or ""):gmatch("[^\n]+") do
                    local _file, name, _desc, _kind, _state, slug = line:match("^(.-)\t(.-)\t(.-)\t(.-)\t(.)\t(.-)$")
                    if slug and slug ~= "" and not projects_seen[slug] then
                        projects_seen[slug] = true
                        table.insert(projects, {
                            title = name,
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
                    confirm = function(picker, item)
                        picker:close()
                        if item.slug then
                            vim.system({ work_bin, "append-task", item.file, description }, {}, function(r)
                                vim.schedule(function()
                                    if r.code == 0 then
                                        vim.cmd.edit(item.file)
                                        vim.notify("Added task to " .. item.title, vim.log.levels.INFO)
                                    else
                                        vim.notify("Failed to add task", vim.log.levels.ERROR)
                                    end
                                end)
                            end)
                        else
                            vim.ui.input({ prompt = "Project title: " }, function(title)
                                if not title or title == "" then
                                    return
                                end
                                local slug = title:lower():gsub("[^%w]+", "-"):gsub("^-+", ""):gsub("-+$", "")
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
                                        vim.system({ work_bin, "append-task", file, description }, {}, function(ar)
                                            vim.schedule(function()
                                                if ar.code == 0 then
                                                    vim.notify("Created project and added task", vim.log.levels.INFO)
                                                else
                                                    vim.notify("Failed to add task", vim.log.levels.ERROR)
                                                end
                                            end)
                                        end)
                                    end)
                                end)
                            end)
                        end
                    end,
                })
            end)
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
            pick_task,
            mode = { "n" },
            desc = "Pick task and start Agentic session",
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
    },
}
