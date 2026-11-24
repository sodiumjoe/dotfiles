local work_bin = vim.env.HOME .. "/bin/work"
local projects_dir = vim.env.HOME .. "/stripe/work/projects/"
local agentic_utils = require("sodium.agentic_utils")

local picker_layout_no_preview = {
    reverse = true,
    layout = {
        box = "vertical",
        backdrop = false,
        width = 0.9,
        height = 0.9,
        border = "none",
        { win = "list", title = " Results ", title_pos = "center", border = "rounded" },
        {
            win = "input",
            height = 1,
            border = "rounded",
            title = "{title} {live} {flags}",
            title_pos = "center",
        },
    },
}

local function split_line_anchor(ref)
    local path, line = ref:match("^(.+)#L(%d+)%-L%d+$")
    if not path or not line then
        path, line = ref:match("^(.+)#L(%d+)$")
    end
    if not path or not line then
        path, line = ref:match("^(.+):(%d+)$")
    end
    return path, tonumber(line)
end

local function markdown_link_destination()
    local text = vim.api.nvim_get_current_line()
    local col = vim.api.nvim_win_get_cursor(0)[2] + 1
    local init = 1
    while true do
        local s, e, dest = text:find("%b[]%(([^)]*)%)", init)
        if not s or s > col then
            return
        end
        if col <= e then
            dest = vim.trim(dest)
            local bracketed = dest:match("^<(.*)>$")
            if bracketed then
                dest = bracketed:gsub("\\([<>])", "%1")
            else
                dest = dest:match("^(%S+)")
            end
            return dest
        end
        init = e + 1
    end
end

local function chat_path(path)
    if path:match("^[~$]") then
        path = vim.fn.expand(path)
    end
    local view = require("sodium.agency").view_for_buffer(vim.api.nvim_get_current_buf())
    local cwd = view and view._agency_cwd
    local absolute = cwd and path:sub(1, 1) ~= "/" and vim.fs.normalize(cwd .. "/" .. path)
        or vim.fn.fnamemodify(path, ":p")
    if vim.uv.fs_stat(absolute) then
        return absolute
    end
end

local function current_path_reference()
    local path, line
    local dest = markdown_link_destination()
    if dest and dest ~= "" and not dest:match("^%a[%w+.-]*://") then
        path, line = split_line_anchor(dest)
        path = path or dest
    else
        local word = vim.fn.expand("<cWORD>")
        if word == "" then
            return
        end

        word = word:gsub("^[`(<%[]+", "")
        word = word:gsub("[`>%)%],.;]+$", "")

        path, line = split_line_anchor(word)
        if not path or not line then
            return
        end
    end

    local absolute = chat_path(path)
    if absolute then
        return absolute, line
    end
end

local function open_path_reference()
    local path, line = current_path_reference()
    if not path then
        return false
    end

    if vim.w.agentic_bufnr ~= nil then
        require("sodium.agency.screen").focus_document()
    end

    vim.cmd("edit " .. (line and ("+" .. line .. " ") or "") .. vim.fn.fnameescape(path))
    return true
end

local function open_file_under_cursor()
    if vim.w.agentic_bufnr == nil then
        return vim.cmd.normal({ args = { "gF" }, bang = true })
    end
    local name = vim.fn.expand("<cfile>")
    local path = name ~= "" and chat_path(name)
    if not path then
        return vim.notify(('E447: Can\'t find file "%s" in path'):format(name), vim.log.levels.ERROR)
    end
    require("sodium.agency.screen").focus_document()
    vim.cmd("edit " .. vim.fn.fnameescape(path))
end

local function start_project_session(proj)
    require("sodium.agency").new(nil, { environment = { CLAUDE_PROJECT = proj or "" } })
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
                        file = projects_dir .. slug .. "/project.md",
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
                    if a.score ~= b.score then
                        return a.score > b.score
                    end
                    return a.sort_idx < b.sort_idx
                end,
                preview = function(ctx)
                    local item = ctx.item
                    if not item or not item.file then
                        return
                    end
                    local lines = vim.fn.readfile(item.file)
                    ctx.preview:set_lines(lines)
                end,
                format = function(item)
                    local ret = { { item.text } }
                    if item.status == "evergreen" then
                        ret[#ret + 1] = { " (evergreen)", "SnacksPickerDir" }
                    end
                    return ret
                end,
                confirm = function(picker, item)
                    if not item then
                        return
                    end
                    picker:close()
                    require("sodium.agency.screen").focus_document()
                    vim.cmd.edit(item.file)
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
                local project_file = projects_dir .. slug .. "/project.md"
                require("sodium.agency.screen").focus_document()
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
            if a.score ~= b.score then
                return a.score > b.score
            end
            return a.sort_idx < b.sort_idx
        end,
        preview = function(ctx)
            local item = ctx.item
            if not item or not item.file then
                return
            end
            local lines = vim.fn.readfile(item.file)
            ctx.preview:set_lines(lines)
        end,
        format = function(item)
            local ret = {
                {
                    agentic_utils.state_display[item.state] .. " ",
                    item.state == "/" and "SnacksPickerLabel"
                        or item.state == "x" and "SnacksPickerComment"
                        or "SnacksPickerDir",
                },
            }
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
            if not item then
                return
            end
            picker:close()
            require("sodium.agency.screen").focus_document()
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
                if not item then
                    return
                end
                local next_state = agentic_utils.state_cycle[item.state]
                if not next_state then
                    return
                end
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
                            file = projects_dir .. slug .. "/project.md",
                        }
                    end
                end
                Snacks.picker({
                    title = "Select Project",
                    items = items,
                    preview = false,
                    layout = picker_layout_no_preview,
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
                        if not item then
                            return
                        end
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
            require("sodium.agency.screen").focus_document()
            local bufnr = vim.fn.bufnr(file)
            if bufnr ~= -1 then
                vim.api.nvim_buf_call(bufnr, function()
                    vim.cmd("edit")
                end)
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
                        file = projects_dir .. slug .. "/project.md",
                    })
                end
            end

            Snacks.picker({
                title = "Select Project",
                items = projects,
                preview = false,
                layout = picker_layout_no_preview,
                format = function(item)
                    return { { item.title } }
                end,
                on_show = function()
                    vim.cmd.stopinsert()
                end,
                confirm = function(picker, item)
                    if not item then
                        return
                    end
                    picker:close()
                    if item.slug then
                        vim.ui.input({ prompt = "Task: " }, function(description)
                            if not description or description == "" then
                                return
                            end
                            add_task_finish(item.file, item.title, description)
                        end)
                    else
                        vim.ui.input({ prompt = "Project title: " }, function(title)
                            if not title or title == "" then
                                return
                            end
                            local slug = agentic_utils.slugify(title)
                            vim.system({ work_bin, "create-project", slug, title }, { text = true }, function(cr)
                                vim.schedule(function()
                                    if cr.code ~= 0 then
                                        vim.notify("create-project failed: " .. (cr.stderr or ""), vim.log.levels.ERROR)
                                        return
                                    end
                                    local file = projects_dir .. slug .. "/project.md"
                                    vim.ui.input({ prompt = "Task: " }, function(description)
                                        if not description or description == "" then
                                            return
                                        end
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

local function send_annotations_to_agentic()
    require("sodium.agency").submit_text("Address each captured annotation.", { annotations = true, conversation = true })
end

local function pick_pr_for_review()
    local review = require("sodium.review")
    vim.system({
        "gh",
        "pr",
        "list",
        "--assignee",
        "@me",
        "--json",
        "number,title,author,headRefName,baseRefName,reviewDecision,isDraft",
        "--limit",
        "30",
    }, { text = true }, function(result)
        vim.schedule(function()
            if result.code ~= 0 then
                vim.notify("gh pr list failed: " .. (result.stderr or ""), vim.log.levels.ERROR)
                return
            end
            local items = review.parse_pr_list(result.stdout)
            if #items == 0 then
                vim.notify("No open PRs", vim.log.levels.INFO)
                return
            end

            for i, item in ipairs(items) do
                item.sort_idx = i
            end

            local diff_cache = {}

            Snacks.picker({
                title = "Pull Requests (<CR> agent, <C-s> session)",
                items = items,
                preview = function(ctx)
                    local item = ctx.item
                    if not item then
                        return
                    end
                    local cached = diff_cache[item.number]
                    if cached then
                        ctx.preview:set_lines(vim.split(cached, "\n"))
                        ctx.preview:highlight({ ft = "diff" })
                        return
                    end
                    ctx.preview:set_lines({ "Loading diff..." })
                    vim.system({ "gh", "pr", "diff", tostring(item.number) }, { text = true }, function(r)
                        vim.schedule(function()
                            local text = r.code == 0 and r.stdout or ("Error: " .. (r.stderr or ""))
                            diff_cache[item.number] = text
                            local preview_win = ctx.preview and ctx.preview.win
                            if not (preview_win and preview_win.valid and preview_win:valid()) then
                                return
                            end
                            local current = ctx.picker:current()
                            if current and current.number == item.number then
                                ctx.preview:set_lines(vim.split(text, "\n"))
                                ctx.preview:highlight({ ft = "diff" })
                            end
                        end)
                    end)
                end,
                sort = function(a, b)
                    if a.score ~= b.score then
                        return a.score > b.score
                    end
                    return a.sort_idx < b.sort_idx
                end,
                format = function(item)
                    local ret = {}
                    ret[#ret + 1] = { string.format("#%d ", item.number), "SnacksPickerLabel" }
                    ret[#ret + 1] = { item.title }
                    ret[#ret + 1] = { string.format(" (%s)", item.author), "SnacksPickerDir" }
                    if item.isDraft then
                        ret[#ret + 1] = { " [draft]", "SnacksPickerComment" }
                    end
                    if item.reviewDecision == "APPROVED" then
                        ret[#ret + 1] = { " [approved]", "SnacksPickerSpecial" }
                    elseif item.reviewDecision == "CHANGES_REQUESTED" then
                        ret[#ret + 1] = { " [changes requested]", "SnacksPickerLabel" }
                    end
                    return ret
                end,
                on_show = function()
                    vim.cmd.stopinsert()
                end,
                win = {
                    input = {
                        keys = {
                            ["<C-s>"] = { "start_mechanical_review", mode = { "n", "i" } },
                        },
                    },
                },
                confirm = function(picker, item)
                    if not item then
                        return
                    end
                    picker:close()
                    local Registry = require("agentic.session_registry")
                    local session = Registry.resolve_or_create()
                    if not session then
                        return
                    end
                    Registry.show_session(session.session_key)
                    session:on_session_ready(function()
                        require("sodium.review_ui").send_agent_command("/neovim-review " .. tostring(item.number), session.session_key)
                    end)
                end,
                actions = {
                    start_mechanical_review = function(picker)
                        local item = picker:current()
                        if not item then
                            return
                        end
                        picker:close()
                        vim.system(
                            { vim.env.HOME .. "/bin/work", "review", "enter-pr", tostring(item.number) },
                            { text = true },
                            function(r)
                                vim.schedule(function()
                                    if r.code == 0 then
                                        vim.notify("PR #" .. tostring(item.number) .. " session ready - <leader>pf", vim.log.levels.INFO)
                                    else
                                        vim.notify("PR review start failed: " .. (r.stderr or ""), vim.log.levels.ERROR)
                                    end
                                end)
                            end
                        )
                    end,
                },
            })
        end)
    end)
end

return {
    "sodiumjoe/agentic.nvim",
    branch = "sodium",
    dir = vim.env.AGENTIC_NVIM_DIR ~= "" and vim.env.AGENTIC_NVIM_DIR or nil,
    cmd = { "AgencyPermissions", "Agency", "AgencyCurrent", "AgencyNew", "AgencyOpen", "AgencyAttach", "AgencyRestore",
        "AgencySettings", "AgencyDetach", "AgencyCancel", "AgencyStop", "AgencyInspect", "AgencyReload" },
    config = function()
        local utils = require("sodium.utils")
        local diagnostics = require("sodium.config.diagnostics")

        local function noop()
            return ""
        end

        local function notify_agent(reason)
            local notify = vim.fn.expand("$HOME/.claude/hooks/notify-on-idle.sh")
            if vim.fn.executable(notify) ~= 1 then
                return
            end

            vim.fn.jobstart({ notify }, {
                detach = true,
                env = {
                    NOTIFY_AGENT_NAME = "Agent",
                    NOTIFY_REASON = reason,
                },
            })
        end

        local function notify_agent_response_complete()
            notify_agent("is waiting for input")
        end

        local function notify_agent_permission_request()
            notify_agent("needs permission")
        end

        local providers = { agency = { name = "Agency", render_live_user_messages = true, command = "sh", args = { "-c", [[
status=$(agy status --json) || {
    printf '%s\n' "$status" >&2
    exit 70
}
exec agy acp]] } } }
        for name in pairs(require("agentic.config_default").acp_providers) do providers[name] = false end
        require("agentic").setup({
            image_paste = {
                enabled = false,
            },
            file_picker = {
                enabled = false,
            },
            border_style = "boxed",
            provider = "agency",
            acp_providers = providers,
            windows = {
                height = 0.5,
                position = "stacked",
                code = diagnostics.window_opts,
                files = diagnostics.window_opts,
                input = vim.tbl_extend("force", diagnostics.window_opts, { height = 0.25, top_padding = true }),
                todos = diagnostics.window_opts,
                chat = vim.tbl_deep_extend("force", diagnostics.window_opts, { win_opts = { foldminlines = 0 } }),
                diagnostics = diagnostics.window_opts,
            },
            headers = {
                chat = noop,
                input = noop,
                code = noop,
                files = noop,
                todos = noop,
            },
            folding = {
                tool_calls = { enabled = true, threshold = 0, fold_on_error = true, fold_completed_diffs = true },
                thinking = { enabled = true },
                group_adjacent = true,
                group_icon = "",
            },
            keymaps = {
                widget = {
                    switch_provider = {},
                },
            },
            hooks = {
                on_response_complete = notify_agent_response_complete,
                on_request_permission = notify_agent_permission_request,
            },
        })

        utils.augroup("AgenticResize", { clear = true })("VimResized", {
            callback = function()
                require("sodium.agency.screen").resize()
            end,
        })

        require("agentic.config").acp_providers.agency.client_class = require("sodium.agency.client").class
        require("sodium.agency").setup()

        utils.augroup("AgenticChatLinks", { clear = true })("FileType", {
            pattern = "AgenticChat",
            callback = function(ev)
                vim.keymap.set("n", "gf", function()
                    if open_path_reference() then
                        return
                    end
                    open_file_under_cursor()
                end, { buf = ev.buf, silent = true })

                vim.keymap.set("n", "<CR>", function()
                    if open_path_reference() then
                        return
                    end
                    vim.cmd.normal({ args = { "+" }, bang = true })
                end, { buf = ev.buf, silent = true })
            end,
        })
    end,
    keys = {
        {
            "<leader>ac",
            function() require("sodium.agency").current() end,
            mode = { "n" },
            desc = "Agency current directory",
        },
        {
            "<leader>aa",
            function() require("sodium.agency").add_context() end,
            mode = { "n", "v" },
            desc = "Agency add captured file or selection",
        },
        {
            "<leader>ao",
            function() require("sodium.agency").open() end,
            mode = { "n" },
            desc = "Agency open attachment",
        },
        {
            "<leader>an",
            function() require("sodium.agency").new() end,
            mode = { "n" },
            desc = "Agency new session",
        },
        {
            "<leader>ae",
            function() require("sodium.agency").settings() end,
            mode = { "n" },
            desc = "Agency agent settings",
        },
        {
            "<leader>af",
            function() require("sodium.agency").roster() end,
            mode = { "n" },
            desc = "Agency active agents",
        },
        {
            "<leader>as",
            function() require("sodium.agency").stop() end,
            mode = { "n" },
            desc = "Agency stop observed agent",
        },
        {
            "<leader>ar",
            function()
                require("sodium.agentic_sessions").show_picker()
            end,
            mode = { "n" },
            desc = "Agency saved sessions",
        },
        {
            "<leader>aR",
            "<cmd>AgencyReload<cr>",
            mode = { "n" },
            desc = "Agency reload Handler",
        },
        {
            "<leader>ad",
            function()
                require("sodium.agency").add_diagnostics("line")
            end,
            desc = "Add current line diagnostic to Agentic",
            mode = { "n" },
        },
        {
            "<leader>aD",
            function()
                require("sodium.agency").add_diagnostics("buffer")
            end,
            desc = "Add all buffer diagnostics to Agentic",
            mode = { "n" },
        },
        {
            "<leader>ap",
            pick_project,
            mode = { "n" },
            desc = "Pick project file",
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
            function()
                require("sodium.agency.screen").resize()
            end,
            mode = { "n" },
            desc = "Rebalance agentic split to 50%",
        },
        {
            "<leader>ai",
            send_annotations_to_agentic,
            mode = { "n" },
            desc = "Inject annotations into Agentic",
        },
        {
            "<leader>pr",
            pick_pr_for_review,
            mode = { "n" },
            desc = "Pick PR and start review session",
        },
    },
}