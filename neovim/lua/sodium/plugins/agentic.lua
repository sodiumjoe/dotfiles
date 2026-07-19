local work_bin = vim.env.HOME .. "/.dotfiles/work-cli/bin/work"
local projects_dir = vim.env.HOME .. "/stripe/work/projects/"
local agentic_utils = require("sodium.agentic_utils")
local agentic_tool_call_log = vim.fn.stdpath("state") .. "/agentic-codex-tool-call.log"

local agentic_filetypes = { "AgenticChat", "AgenticInput", "AgenticCode", "AgenticFiles", "AgenticTodos" }

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

local function serialize_tool_call_value(value, seen)
    if value == vim.NIL then
        return "vim.NIL"
    end

    local value_type = type(value)
    if value_type == "userdata" or value_type == "function" or value_type == "thread" then
        return value_type
    end

    if value_type ~= "table" then
        return value
    end

    seen = seen or {}
    if seen[value] then
        return "<cycle>"
    end
    seen[value] = true

    local serialized = {}
    if vim.islist(value) then
        for i, item in ipairs(value) do
            serialized[i] = serialize_tool_call_value(item, seen)
        end
    else
        for key, item in pairs(value) do
            serialized[tostring(key)] = serialize_tool_call_value(item, seen)
        end
    end

    seen[value] = nil
    return serialized
end

local function append_tool_call_log(entry)
    local file = io.open(agentic_tool_call_log, "a")
    if not file then
        return
    end

    entry.timestamp = os.date("!%Y-%m-%dT%H:%M:%SZ")
    local ok, encoded = pcall(vim.json.encode, entry)
    if ok and type(encoded) == "string" then
        file:write(encoded)
    else
        file:write(vim.inspect(entry))
    end
    file:write("\n")
    file:close()
end

local function normalize_tool_call_update(update)
    local normalized = {}
    local dropped_fields = {}

    if type(update) ~= "table" then
        dropped_fields._update = type(update)
        return normalized, dropped_fields
    end

    local function keep_string(key)
        local value = update[key]
        if type(value) == "string" then
            normalized[key] = value
        elseif value ~= nil then
            dropped_fields[key] = type(value)
        end
    end

    local function keep_table(key)
        local value = update[key]
        if type(value) == "table" then
            normalized[key] = value
        elseif value ~= nil then
            dropped_fields[key] = type(value)
        end
    end

    local function keep_list(key)
        local value = update[key]
        if type(value) == "table" and vim.islist(value) then
            normalized[key] = value
        elseif value ~= nil then
            dropped_fields[key] = type(value)
        end
    end

    keep_string("toolCallId")
    keep_string("kind")
    keep_string("status")
    keep_string("title")
    keep_list("content")
    keep_table("rawInput")
    keep_list("locations")

    return normalized, dropped_fields
end

local function fallback_tool_call_message(update, normalized)
    local source = type(update) == "table" and update or {}
    local message = {
        tool_call_id = normalized.toolCallId or type(source.toolCallId) == "string" and source.toolCallId or nil,
    }

    if normalized.kind then
        message.kind = normalized.kind
    end

    if normalized.status then
        message.status = normalized.status
    end

    if normalized.title and normalized.title ~= "" then
        message.argument = normalized.title
    end

    local raw_input = normalized.rawInput
    if raw_input then
        local file_path = raw_input.file_path or raw_input.filePath
        if type(file_path) == "string" then
            message.file_path = file_path
        end
    end

    if not message.file_path and normalized.locations then
        local first_location = normalized.locations[1]
        if type(first_location) == "table" and type(first_location.path) == "string" then
            message.file_path = first_location.path
        end
    end

    return message
end

local function current_path_reference()
    local word = vim.fn.expand("<cWORD>")
    if word == "" then
        return
    end

    word = word:gsub("^[`(<%[]+", "")
    word = word:gsub("[`>%)%],.;]+$", "")

    local path, line = word:match("^(.+)#L(%d+)%-L%d+$")
    if not path or not line then
        path, line = word:match("^(.+)#L(%d+)$")
    end
    if not path or not line then
        path, line = word:match("^(.+):(%d+)$")
    end
    if not path or not line then
        return
    end

    local absolute = vim.fn.fnamemodify(path, ":p")
    if not vim.uv.fs_stat(absolute) then
        return
    end

    return absolute, tonumber(line)
end

local function open_path_reference()
    local path, line = current_path_reference()
    if not path or not line then
        return false
    end

    vim.cmd("edit +" .. line .. " " .. vim.fn.fnameescape(path))
    return true
end

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

local function days_from_civil(year, month, day)
    year = tonumber(year)
    month = tonumber(month)
    day = tonumber(day)

    if month <= 2 then
        year = year - 1
    end

    local era = math.floor(year / 400)
    local year_of_era = year - era * 400
    local month_prime = month + (month > 2 and -3 or 9)
    local day_of_year = math.floor((153 * month_prime + 2) / 5) + day - 1
    local day_of_era = year_of_era * 365 + math.floor(year_of_era / 4) - math.floor(year_of_era / 100) + day_of_year

    return era * 146097 + day_of_era - 719468
end

local function session_updated_at_sort_key(updated_at)
    if type(updated_at) ~= "string" then
        return nil
    end

    local year, month, day, hour, min, sec, remainder =
        updated_at:match("^(%d%d%d%d)%-(%d%d)%-(%d%d)T(%d%d):(%d%d):(%d%d)(.*)$")
    if not year then
        return nil
    end

    local fraction
    local zone
    if remainder ~= "" then
        local maybe_fraction, maybe_zone = remainder:match("^(%.%d+)(.*)$")
        if maybe_fraction then
            fraction = maybe_fraction
            remainder = maybe_zone
        end

        if remainder == "Z" or remainder == "z" then
            zone = remainder
        elseif remainder ~= "" then
            local sign, zone_hour, zone_min = remainder:match("^([%+%-])(%d%d):?(%d%d)$")
            if not sign then
                return nil
            end

            zone = sign .. zone_hour .. zone_min
        end
    end

    local offset = 0
    if zone and zone ~= "Z" and zone ~= "z" then
        local sign, zone_hour, zone_min = zone:match("^([%+%-])(%d%d):?(%d%d)$")
        if not sign then
            return nil
        end

        offset = (tonumber(zone_hour) * 60 + tonumber(zone_min)) * 60
        if sign == "-" then
            offset = -offset
        end
    end

    local seconds = days_from_civil(year, month, day) * 86400
        + tonumber(hour) * 3600
        + tonumber(min) * 60
        + tonumber(sec)
        - offset
    local fractional = fraction and tonumber(fraction) or 0

    return seconds + fractional
end

local function sort_sessions_reverse_chrono(sessions)
    local decorated = {}
    for i, session in ipairs(sessions) do
        decorated[i] = {
            session = session,
            index = i,
            sort_key = session_updated_at_sort_key(session.updatedAt),
        }
    end

    table.sort(decorated, function(left, right)
        if left.sort_key ~= nil and right.sort_key ~= nil then
            if left.sort_key ~= right.sort_key then
                return left.sort_key > right.sort_key
            end
            return left.index < right.index
        end

        if left.sort_key ~= nil then
            return true
        end

        if right.sort_key ~= nil then
            return false
        end

        return left.index < right.index
    end)

    local sorted = {}
    for i, item in ipairs(decorated) do
        sorted[i] = item.session
    end

    return sorted
end

local function start_project_session(proj)
    local Config = require("agentic.config")
    local AgentInstance = require("agentic.acp.agent_instance")
    local SessionRegistry = require("agentic.session_registry")

    local provider = Config.provider or "claude-agent-acp"
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
                local project_file = projects_dir .. slug .. "/project.md"
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
            local editor_win = require("sodium.utils").editor_window()
            if editor_win then
                vim.api.nvim_set_current_win(editor_win)
            end
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
    local store = require("comment-overlay.store")
    store.reload_if_changed()

    local files = store.get_files_with_comments()
    if #files == 0 then
        vim.notify("No annotations", vim.log.levels.INFO)
        return
    end

    local project_root = store.get_project_root()
    local lines = { "I've annotated several files. Address each annotation.", "" }
    local root_ids = {}

    for _, rel_path in ipairs(files) do
        table.insert(lines, "File: " .. rel_path)
        table.insert(lines, "")
        local roots = store.get_for_file(rel_path, { roots_only = true })
        for _, root in ipairs(roots) do
            if not root.resolved then
                table.insert(root_ids, root.id)
                local thread = store.get_thread(root.id)
                local ls = root.line_start or root.line
                local le = root.line_end or root.line
                local range = (not ls) and "?"
                    or ls == le and string.format("L%d", ls)
                    or string.format("L%d-L%d", ls, le)
                if #thread == 1 then
                    table.insert(lines, string.format("  %s: %q", range, root.body))
                else
                    table.insert(lines, string.format("  %s (thread):", range))
                    for _, c in ipairs(thread) do
                        table.insert(lines, string.format("    - %q", c.body))
                    end
                end
            end
        end
        table.insert(lines, "")
    end

    local SessionRegistry = require("agentic.session_registry")
    SessionRegistry.get_session_for_tab_page(nil, function(session)
        for _, rel_path in ipairs(files) do
            session.file_list:add(project_root .. "/" .. rel_path)
        end

        local input_buf = session.widget.buf_nrs.input
        vim.api.nvim_buf_set_lines(input_buf, 0, -1, false, lines)
        session.widget:show()

        local function try_submit()
            if session.session_id then
                session.widget:_submit_input()
                for _, id in ipairs(root_ids) do
                    store.delete(id)
                end
                store.save()
                pcall(vim.cmd, "CommentRefresh")
            else
                vim.defer_fn(function()
                    try_submit()
                end, 200)
            end
        end
        try_submit()
    end)
end

local function new_session_with_provider(opts)
    local Config = require("agentic.config")
    local ACPHealth = require("agentic.acp.acp_health")

    local installed = {}
    for _, name in ipairs(ACPHealth.get_default_provider_names()) do
        local provider_config = Config.acp_providers[name]
        if provider_config and ACPHealth.is_command_available(provider_config.command) then
            installed[#installed + 1] = name
        end
    end

    if #installed == 0 then
        vim.notify("No ACP providers installed", vim.log.levels.ERROR)
        return
    end

    local function start_with(provider_name)
        local merged = vim.tbl_deep_extend("force", opts or {}, { provider = provider_name })
        require("agentic").new_session(merged)
    end

    if #installed == 1 then
        start_with(installed[1])
        return
    end

    -- Sort: current/default provider first
    local default = Config.provider
    table.sort(installed, function(a, b)
        if a == default then
            return true
        end
        if b == default then
            return false
        end
        return a < b
    end)

    local items = {}
    for i, name in ipairs(installed) do
        local provider_config = Config.acp_providers[name]
        items[i] = {
            text = name,
            provider_name = name,
            sort_idx = i,
            command = provider_config and provider_config.command or "",
        }
    end

    Snacks.picker({
        title = "Provider",
        items = items,
        preview = false,
        layout = picker_layout_no_preview,
        on_show = function()
            vim.cmd.stopinsert()
        end,
        sort = function(a, b)
            if a.score ~= b.score then
                return a.score > b.score
            end
            return a.sort_idx < b.sort_idx
        end,
        format = function(item)
            local ret = { { item.provider_name } }
            if item.provider_name == default then
                ret[#ret + 1] = { " (default)", "SnacksPickerDir" }
            end
            return ret
        end,
        confirm = function(picker, item)
            if not item then
                return
            end
            picker:close()
            start_with(item.provider_name)
        end,
    })
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
                title = "Pull Requests",
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
                confirm = function(picker, item)
                    if not item then
                        return
                    end
                    picker:close()
                    local SessionRegistry = require("agentic.session_registry")
                    SessionRegistry.get_session_for_tab_page(nil, function(session)
                        local input_buf = session.widget.buf_nrs.input
                        vim.api.nvim_buf_set_lines(
                            input_buf,
                            0,
                            -1,
                            false,
                            { "/neovim-review " .. tostring(item.number) }
                        )
                        session.widget:show()
                        local function try_submit()
                            if session.session_id then
                                session.widget:_submit_input()
                            else
                                vim.defer_fn(try_submit, 200)
                            end
                        end
                        try_submit()
                    end)
                end,
            })
        end)
    end)
end

return {
    "carlos-algms/agentic.nvim",
    -- dir = vim.fn.expand("~/home/agentic.nvim"),
    config = function()
        local utils = require("sodium.utils")
        local diagnostics = require("sodium.config.diagnostics")
        local claude_path = vim.fn.resolve(vim.fn.exepath("claude"))
        local codex_binary = vim.fn.resolve(vim.fn.exepath("codex"))

        local function patch_agentic_acp_client()
            local ok, ACPClient = pcall(require, "agentic.acp.acp_client")
            if not ok or ACPClient._sodium_null_field_patch then
                return
            end

            local build_tool_call_message = ACPClient.__build_tool_call_message
            ACPClient.__build_tool_call_message = function(self, update)
                local normalized, dropped_fields = normalize_tool_call_update(update)

                if next(dropped_fields) ~= nil then
                    append_tool_call_log({
                        event = "malformed_tool_call_payload",
                        toolCallId = normalized.toolCallId,
                        dropped_fields = dropped_fields,
                        payload = serialize_tool_call_value(update),
                    })
                end

                local ok2, message = pcall(build_tool_call_message, self, normalized)
                if ok2 then
                    return message
                end

                append_tool_call_log({
                    event = "tool_call_render_error",
                    error = tostring(message),
                    toolCallId = normalized.toolCallId,
                    dropped_fields = next(dropped_fields) ~= nil and dropped_fields or nil,
                    payload = serialize_tool_call_value(update),
                    normalized = serialize_tool_call_value(normalized),
                })

                return fallback_tool_call_message(update, normalized)
            end
            ACPClient._sodium_null_field_patch = true
        end

        local function patch_agentic_session_restore()
            local ok, SessionRestore = pcall(require, "agentic.session_restore")
            if
                not ok
                or SessionRestore._sodium_reverse_chrono_patch
                or type(SessionRestore.show_picker) ~= "function"
            then
                return
            end

            local ChatHistory = require("agentic.ui.chat_history")
            local original_list_sessions = ChatHistory.list_sessions
            ChatHistory.list_sessions = function(callback)
                return original_list_sessions(function(sessions)
                    callback(sort_sessions_reverse_chrono(sessions))
                end)
            end
            SessionRestore._sodium_reverse_chrono_patch = true
        end

        local function noop()
            return ""
        end

        local function notify_agent_response_complete()
            local notify = vim.fn.expand("$HOME/.claude/hooks/notify-on-idle.sh")
            if vim.fn.executable(notify) ~= 1 then
                return
            end

            vim.fn.jobstart({ notify }, {
                detach = true,
                env = {
                    NOTIFY_AGENT_NAME = "Agent",
                },
            })
        end

        patch_agentic_acp_client()
        patch_agentic_session_restore()

        require("agentic").setup({
            image_paste = {
                enabled = false,
            },
            file_picker = {
                enabled = false,
            },
            border_style = "boxed",
            provider = "codex-acp",
            acp_providers = {
                ["claude-acp"] = false,
                ["claude-agent-acp"] = {
                    command = "claude-agent-acp",
                    env = {
                        NODE_NO_WARNINGS = "1",
                        IS_AI_TERMINAL = "1",
                        NODENV_VERSION = "24.13.0",
                        CLAUDE_CODE_EXECUTABLE = claude_path,
                        NVIM = vim.v.servername,
                    },
                },
                ["gemini-acp"] = {
                    command = "gemini",
                    args = { "--experimental-acp" },
                    env = {},
                },
                ["codex-acp"] = {
                    command = "codex-acp",
                    default_mode = "agent-full-access",
                    env = {
                        CODEX_PATH = codex_binary ~= "" and codex_binary or nil,
                        INITIAL_AGENT_MODE = "agent-full-access",
                        MODEL_PROVIDER = "litellm",
                        NVIM = vim.v.servername,
                    },
                },
            },
            windows = {
                height = 0.5,
                width = 0.4,
                stack_width_ratio = 0.3,
                position = "bottom",
                code = diagnostics.window_opts,
                files = diagnostics.window_opts,
                input = diagnostics.window_opts,
                todos = diagnostics.window_opts,
                chat = diagnostics.window_opts,
                diagnostics = diagnostics.window_opts,
            },
            headers = {
                chat = noop,
                input = noop,
                code = noop,
                files = noop,
                todos = noop,
            },
            hooks = {
                on_response_complete = notify_agent_response_complete,
            },
        })

        utils.augroup("AgenticResize", { clear = true })("VimResized", {
            callback = resize_agentic_split,
        })

        utils.augroup("AgenticChatLinks", { clear = true })("FileType", {
            pattern = "AgenticChat",
            callback = function(ev)
                vim.keymap.set("n", "gf", function()
                    if open_path_reference() then
                        return
                    end
                    vim.cmd.normal({ args = { "gF" }, bang = true })
                end, { buffer = ev.buf, silent = true })

                vim.keymap.set("n", "<CR>", function()
                    if open_path_reference() then
                        return
                    end
                    vim.cmd.normal({ args = { "+" }, bang = true })
                end, { buffer = ev.buf, silent = true })
            end,
        })
    end,
    keys = {
        {
            "<leader>ac",
            function()
                local SessionRegistry = require("agentic.session_registry")
                local tab_page_id = vim.api.nvim_get_current_tabpage()
                if SessionRegistry.sessions[tab_page_id] then
                    require("agentic").toggle()
                else
                    new_session_with_provider()
                end
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
            new_session_with_provider,
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
        {
            "<leader>pf",
            function()
                local review = require("sodium.review")
                local diff_mod = require("sodium.diff")
                local utils = require("sodium.utils")

                local session = review.get_session()
                if not session then
                    vim.notify("No review session active", vim.log.levels.WARN)
                    return
                end

                local items = review.get_files()
                if #items == 0 then
                    vim.notify("No changed files", vim.log.levels.INFO)
                    return
                end

                -- Refresh reviewed state from session
                for _, item in ipairs(items) do
                    item.reviewed = review.is_reviewed(item.rel)
                end

                local file_diffs = review.get_file_diffs()

                local title = session.mode == "pr" and string.format("PR #%s Files", session.id)
                    or string.format("Review: %s", session.id)

                Snacks.picker({
                    title = title,
                    items = items,
                    preview = function(ctx)
                        local item = ctx.item
                        if not item then
                            return
                        end
                        local cached = file_diffs[item.rel]
                        if cached then
                            ctx.preview:set_lines(vim.split(cached, "\n"))
                            ctx.preview:highlight({ ft = "diff" })
                        else
                            ctx.preview:set_lines({ "No diff available" })
                        end
                    end,
                    sort = function(a, b)
                        if a.score ~= b.score then
                            return a.score > b.score
                        end
                        return a.sort_idx < b.sort_idx
                    end,
                    format = function(item)
                        local marker = item.reviewed and "[x] " or "[ ] "
                        local hl = item.reviewed and "SnacksPickerComment" or "SnacksPickerDir"
                        local name_hl = item.exists and nil or "SnacksPickerComment"
                        return { { marker, hl }, { item.rel, name_hl } }
                    end,
                    on_show = function()
                        vim.cmd.stopinsert()
                    end,
                    win = {
                        input = {
                            keys = {
                                ["<Tab>"] = { "toggle_reviewed", mode = { "n", "i" } },
                                ["<C-o>"] = { "open_file", mode = { "n", "i" } },
                            },
                        },
                    },
                    confirm = function(picker, item)
                        if not item then
                            return
                        end
                        if not item.exists then
                            vim.notify(item.rel .. " not available locally", vim.log.levels.WARN)
                            return
                        end
                        picker:close()
                        vim.schedule(function()
                            diff_mod.open({
                                mode = "refs",
                                file = item.file,
                                left_ref = session.base_ref,
                                right_ref = session.head_ref,
                                toplevel = session.toplevel,
                            })
                        end)
                    end,
                    actions = {
                        toggle_reviewed = function(picker)
                            local item = picker:current()
                            if not item then
                                return
                            end
                            review.toggle_reviewed(item.rel)
                            item.reviewed = review.is_reviewed(item.rel)
                            picker.list:update({ force = true })
                        end,
                        open_file = function(picker)
                            local item = picker:current()
                            if not item then
                                return
                            end
                            if not item.exists then
                                vim.notify(item.rel .. " not available locally", vim.log.levels.WARN)
                                return
                            end
                            picker:close()
                            vim.schedule(function()
                                local win = utils.editor_window()
                                if win then
                                    vim.api.nvim_set_current_win(win)
                                end
                                utils.close_non_agentic_windows()
                                vim.cmd.edit(item.file)
                            end)
                        end,
                    },
                })
            end,
            mode = { "n" },
            desc = "Review file picker",
        },
        {
            "<leader>pn",
            function()
                local review = require("sodium.review")
                local utils = require("sodium.utils")
                local s = review.get_session()
                if not s then
                    vim.notify("No review session active", vim.log.levels.WARN)
                    return
                end
                local root = s.toplevel or ""
                local filepath = vim.api.nvim_buf_get_name(0)
                if root ~= "" and filepath:sub(1, #root + 1) == root .. "/" then
                    filepath = filepath:sub(#root + 2)
                end
                review.toggle_reviewed(filepath)
                local is_reviewed = review.is_reviewed(filepath)
                utils.close_non_agentic_windows()
                local marker = is_reviewed and "reviewed" or "unreviewed"
                vim.notify(filepath .. " marked " .. marker)
                -- Reopen picker by simulating <leader>pf
                vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<leader>pf", true, false, true), "m", false)
            end,
            mode = { "n" },
            desc = "Mark reviewed and reopen file picker",
        },
        {
            "<leader>pa",
            function()
                local s = require("sodium.review").get_session()
                if not s then
                    vim.notify("No review session active", vim.log.levels.WARN)
                    return
                end
                if s.mode ~= "pr" then
                    vim.notify("Not in PR mode", vim.log.levels.WARN)
                    return
                end
                vim.ui.select(
                    { "APPROVE", "REQUEST_CHANGES", "COMMENT" },
                    { prompt = "PR #" .. s.id .. " review:" },
                    function(choice)
                        if not choice then
                            return
                        end
                        local script = vim.env.HOME .. "/.claude/skills/neovim-review/scripts/review-approve"
                        vim.notify("Submitting " .. choice:lower() .. " for PR #" .. s.id .. "...")
                        vim.system({ script, choice }, { text = true }, function(r)
                            vim.schedule(function()
                                if r.code == 0 then
                                    vim.notify("PR #" .. s.id .. " — " .. choice:lower(), vim.log.levels.INFO)
                                else
                                    vim.notify("Submit failed: " .. (r.stderr or ""), vim.log.levels.ERROR)
                                end
                            end)
                        end)
                    end
                )
            end,
            mode = { "n" },
            desc = "Submit PR review and exit",
        },
    },
}
