local review = require("sodium.review")

local function git_toplevel()
    local result = vim.system({ "git", "rev-parse", "--show-toplevel" }, { text = true }):wait()
    if result.code == 0 and result.stdout then
        return vim.trim(result.stdout)
    end
    return nil
end

local function open_diff(filepath, base_ref)
    local editor_win = require("sodium.utils").editor_window()
    if editor_win then
        vim.api.nvim_set_current_win(editor_win)
    end
    vim.cmd.edit(filepath)
    local ok, err = pcall(vim.cmd, "Gdiffsplit origin/" .. base_ref)
    if not ok then
        vim.notify("Gdiffsplit failed: " .. (err or "unknown error"), vim.log.levels.WARN)
    end
end

local function setup_gdiffsplit_override()
    vim.api.nvim_create_user_command("Gdiffsplit", function(opts)
        local pr = review.get_current_pr()
        local arg = opts.args
        if arg == "" and pr then
            arg = "origin/" .. pr.baseRefName
        end
        local ok2, err2 = pcall(vim.cmd, "Gitsplit " .. arg)
        if not ok2 then
            vim.notify("Gdiffsplit failed: " .. (err2 or "unknown error"), vim.log.levels.WARN)
        end
    end, { nargs = "?", bang = true })
end

local function teardown_gdiffsplit_override()
    pcall(vim.api.nvim_del_user_command, "Gdiffsplit")
end

local function fetch_and_display_comments(pr)
    local root = pr.toplevel or git_toplevel() or ""
    if root == "" then return end
    vim.system(
        { "gh", "api", "repos/{owner}/{repo}/pulls/" .. tostring(pr.number) .. "/comments", "--paginate" },
        { text = true },
        function(r)
            vim.schedule(function()
                if r.code ~= 0 then
                    vim.notify("Failed to fetch PR comments: " .. (r.stderr or ""), vim.log.levels.WARN)
                    return
                end
                local by_id, files = review.parse_gh_comments(r.stdout)
                if not next(by_id) then return end
                local data = review.build_comments_v2(by_id, files)
                local path = root .. "/.nvim-comments.json"
                review.write_comments_json(path, data)
                pcall(vim.cmd, "CommentRefresh")
            end)
        end
    )
end

local function pick_pr_files()
    local pr = review.get_current_pr()
    if not pr then
        vim.notify("No PR selected. Use <leader>pr first.", vim.log.levels.WARN)
        return
    end

    vim.system(
        { "gh", "pr", "diff", tostring(pr.number) },
        { text = true },
        function(result)
            vim.schedule(function()
                if result.code ~= 0 then
                    vim.notify("gh pr diff failed: " .. (result.stderr or ""), vim.log.levels.ERROR)
                    return
                end
                local file_diffs, files = review.parse_file_diffs(result.stdout)
                if #files == 0 then
                    vim.notify("No changed files", vim.log.levels.INFO)
                    return
                end

                local root = pr.toplevel or git_toplevel() or ""
                local items = {}
                for i, filepath in ipairs(files) do
                    local abs = root ~= "" and (root .. "/" .. filepath) or filepath
                    items[#items + 1] = {
                        text = filepath,
                        file = abs,
                        rel = filepath,
                        sort_idx = i,
                        reviewed = review.is_reviewed(filepath),
                    }
                end

                Snacks.picker({
                    title = string.format("PR #%d Files (%s)", pr.number, pr.headRefName),
                    items = items,
                    preview = function(ctx)
                        local item = ctx.item
                        if not item then return end
                        local diff = file_diffs[item.rel]
                        if diff then
                            ctx.preview:set_lines(vim.split(diff, "\n"))
                            ctx.preview:highlight({ ft = "diff" })
                        else
                            ctx.preview:set_lines({ "No diff available" })
                        end
                    end,
                    sort = function(a, b)
                        if a.score ~= b.score then return a.score > b.score end
                        return a.sort_idx < b.sort_idx
                    end,
                    format = function(item)
                        local marker = item.reviewed and "[x] " or "[ ] "
                        local hl = item.reviewed and "SnacksPickerComment" or "SnacksPickerDir"
                        return {
                            { marker, hl },
                            { item.rel },
                        }
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
                        if not item then return end
                        picker:close()
                        vim.schedule(function()
                            open_diff(item.file, pr.baseRefName)
                        end)
                    end,
                    actions = {
                        toggle_reviewed = function(picker)
                            local item = picker:current()
                            if not item then return end
                            review.toggle_reviewed(item.rel)
                            item.reviewed = review.is_reviewed(item.rel)
                            picker.list:update({ force = true })
                        end,
                        open_file = function(picker)
                            local item = picker:current()
                            if not item then return end
                            picker:close()
                            vim.schedule(function()
                                local editor_win = require("sodium.utils").editor_window()
                                if editor_win then
                                    vim.api.nvim_set_current_win(editor_win)
                                end
                                vim.cmd.edit(item.file)
                            end)
                        end,
                    },
                })
            end)
        end
    )
end

local function pick_pr()
    vim.system(
        { "gh", "pr", "list", "--assignee", "@me", "--json", "number,title,author,headRefName,baseRefName,reviewDecision,isDraft", "--limit", "30" },
        { text = true },
        function(result)
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
                        if not item then return end
                        local cached = diff_cache[item.number]
                        if cached then
                            ctx.preview:set_lines(vim.split(cached, "\n"))
                            ctx.preview:highlight({ ft = "diff" })
                            return
                        end
                        ctx.preview:set_lines({ "Loading diff..." })
                        vim.system(
                            { "gh", "pr", "diff", tostring(item.number) },
                            { text = true },
                            function(r)
                                vim.schedule(function()
                                    local text = r.code == 0 and r.stdout or ("Error: " .. (r.stderr or ""))
                                    diff_cache[item.number] = text
                                    local current = ctx.picker:current()
                                    if current and current.number == item.number then
                                        ctx.preview:set_lines(vim.split(text, "\n"))
                                        ctx.preview:highlight({ ft = "diff" })
                                    end
                                end)
                            end
                        )
                    end,
                    sort = function(a, b)
                        if a.score ~= b.score then return a.score > b.score end
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
                        if not item then return end
                        picker:close()
                        item.toplevel = git_toplevel()
                        review.set_current_pr(item)
                        setup_gdiffsplit_override()
                        local branch_result = vim.system({ "git", "rev-parse", "--abbrev-ref", "HEAD" }, { text = true }):wait()
                        if branch_result.code == 0 and branch_result.stdout then
                            review.set_previous_branch(vim.trim(branch_result.stdout))
                        end
                        vim.system({ "gh", "api", "user", "--jq", ".login" }, { text = true }, function(u)
                            vim.schedule(function()
                                if u.code == 0 and u.stdout then
                                    local user = vim.trim(u.stdout)
                                    review.set_current_user(user)
                                    vim.g.comment_overlay_actor = user
                                end
                            end)
                        end)
                        vim.notify("Checking out PR #" .. item.number .. "...")
                        local function after_checkout()
                            local base = item.baseRefName
                            vim.system(
                                { "git", "fetch", "origin", base .. ":" .. "refs/remotes/origin/" .. base },
                                { text = true },
                                function(fetch_result)
                                    vim.schedule(function()
                                        if fetch_result.code ~= 0 then
                                            vim.notify("git fetch base branch failed: " .. (fetch_result.stderr or ""), vim.log.levels.WARN)
                                        end
                                        vim.cmd("checktime")
                                        fetch_and_display_comments(item)
                                        pick_pr_files()
                                    end)
                                end
                            )
                        end
                        local pr_num = tostring(item.number)
                        vim.system(
                            { "gh", "pr", "checkout", pr_num },
                            { text = true },
                            function(r)
                                vim.schedule(function()
                                    if r.code == 0 then
                                        after_checkout()
                                        return
                                    end
                                    vim.notify("gh pr checkout failed, trying refspec fallback...")
                                    vim.system(
                                        { "git", "fetch", "origin", "pull/" .. pr_num .. "/head" },
                                        { text = true },
                                        function(f)
                                            vim.schedule(function()
                                                if f.code ~= 0 then
                                                    vim.notify("PR checkout failed: " .. (f.stderr or ""), vim.log.levels.ERROR)
                                                    return
                                                end
                                                vim.system({ "git", "checkout", "FETCH_HEAD" }, { text = true }, function(co)
                                                    vim.schedule(function()
                                                        if co.code ~= 0 then
                                                            vim.notify("git checkout failed: " .. (co.stderr or ""), vim.log.levels.ERROR)
                                                            return
                                                        end
                                                        after_checkout()
                                                    end)
                                                end)
                                            end)
                                        end
                                    )
                                end)
                            end
                        )
                    end,
                })
            end)
        end
    )
end

local function diff_current_file()
    local pr = review.get_current_pr()
    if not pr then
        vim.notify("No PR selected", vim.log.levels.WARN)
        return
    end
    local ok, _ = pcall(vim.cmd, "Gdiffsplit")
    if not ok then
        vim.notify("File is new in this PR (no base to diff against)", vim.log.levels.INFO)
    end
end

local function review_and_next()
    local pr = review.get_current_pr()
    if not pr then
        vim.notify("No PR selected", vim.log.levels.WARN)
        return
    end
    local root = pr.toplevel or git_toplevel() or ""
    local filepath = vim.api.nvim_buf_get_name(0)
    if root ~= "" and filepath:sub(1, #root + 1) == root .. "/" then
        filepath = filepath:sub(#root + 2)
    end
    review.toggle_reviewed(filepath)
    local is_reviewed = review.is_reviewed(filepath)
    for _, buf in ipairs(vim.api.nvim_list_bufs()) do
        if require("sodium.utils").is_fugitive_buffer(buf) then
            vim.api.nvim_buf_delete(buf, { force = true })
        end
    end
    local marker = is_reviewed and "reviewed" or "unreviewed"
    vim.notify(filepath .. " marked " .. marker)
    pick_pr_files()
end

local function restore_branch_prompt(callback)
    local branch = review.get_previous_branch()
    if not branch then
        if callback then callback() end
        return
    end
    vim.ui.select({ "yes", "no" }, { prompt = "Restore branch " .. branch .. "?" }, function(choice)
        if choice == "yes" then
            vim.system({ "git", "checkout", branch }, { text = true }, function(r)
                vim.schedule(function()
                    if r.code ~= 0 then
                        vim.notify("git checkout failed: " .. (r.stderr or ""), vim.log.levels.ERROR)
                    else
                        vim.cmd("checktime")
                        vim.notify("Restored branch " .. branch)
                    end
                    if callback then callback() end
                end)
            end)
        else
            if callback then callback() end
        end
    end)
end

local function clear_review_state()
    restore_branch_prompt(function()
        local root = (review.get_current_pr() or {}).toplevel or git_toplevel() or ""
        if root ~= "" then
            os.remove(root .. "/.nvim-comments.json")
            pcall(vim.cmd, "CommentRefresh")
        end
        teardown_gdiffsplit_override()
        review.reset()
        vim.notify("PR review state cleared")
    end)
end

local function add_comment()
    local pr = review.get_current_pr()
    if not pr then
        vim.notify("No PR selected", vim.log.levels.WARN)
        return
    end
    vim.cmd("CommentAdd")
end

local function refresh_comments()
    local pr = review.get_current_pr()
    if not pr then
        vim.notify("No PR selected", vim.log.levels.WARN)
        return
    end
    fetch_and_display_comments(pr)
    vim.notify("Refreshing PR comments...")
end

local function submit_review()
    local pr = review.get_current_pr()
    if not pr then
        vim.notify("No PR selected", vim.log.levels.WARN)
        return
    end
    local root = pr.toplevel or git_toplevel() or ""
    local current_user = review.get_current_user()
    local path = root ~= "" and (root .. "/.nvim-comments.json") or nil
    local local_comments = {}
    if path then
        local data = review.read_comments_json(path)
        if data then
            local_comments = review.filter_local_comments(data, current_user)
        end
    end

    local event_map = { approve = "APPROVE", comment = "COMMENT", ["request changes"] = "REQUEST_CHANGES" }
    vim.ui.select({ "approve", "comment", "request changes" }, { prompt = "Review type:" }, function(choice)
        if not choice then return end
        local event = event_map[choice]
        vim.ui.input({ prompt = "Review body (optional): " }, function(body)
            local api_comments = {}
            for _, c in ipairs(local_comments) do
                api_comments[#api_comments + 1] = {
                    path = c.file,
                    line = c.line,
                    side = "RIGHT",
                    body = c.body,
                }
            end
            local payload = { event = event, body = body or "" }
            if #api_comments > 0 then
                payload.comments = api_comments
            end
            local payload_json = vim.json.encode(payload)
            vim.system(
                { "gh", "api", "repos/{owner}/{repo}/pulls/" .. tostring(pr.number) .. "/reviews",
                  "-X", "POST", "--input", "-" },
                { text = true, stdin = payload_json },
                function(r)
                    vim.schedule(function()
                        if r.code ~= 0 then
                            vim.notify("Review submit failed: " .. (r.stderr or ""), vim.log.levels.ERROR)
                            return
                        end
                        vim.notify("Review submitted: " .. choice)
                        if path then
                            os.remove(path)
                            pcall(vim.cmd, "CommentRefresh")
                        end
                        restore_branch_prompt()
                    end)
                end
            )
        end)
    end)
end

return {
    {
        "tpope/vim-fugitive",
        cmd = { "Gdiffsplit", "Git" },
        keys = {
            { "<leader>pr", pick_pr, mode = "n", desc = "PR list picker" },
            { "<leader>pf", pick_pr_files, mode = "n", desc = "PR changed files picker" },
            { "<leader>pd", diff_current_file, mode = "n", desc = "Diff current file against PR base" },
            { "<leader>pn", review_and_next, mode = "n", desc = "Mark reviewed and return to file picker" },
            { "<leader>px", clear_review_state, mode = "n", desc = "Clear PR review state" },
            { "<leader>pa", add_comment, mode = "n", desc = "Add PR comment on current line" },
            { "<leader>pc", refresh_comments, mode = "n", desc = "Refresh PR comments from GitHub" },
            { "<leader>ps", submit_review, mode = "n", desc = "Submit PR review" },
        },
    },
    {
        "huashuai/nvim-comment-overlay",
        cmd = { "CommentAdd", "CommentRefresh", "CommentDelete", "CommentEdit", "CommentList", "CommentReply", "CommentResolve" },
        config = function()
            require("comment-overlay").setup({})
            local default_keymaps = {
                "<leader>ca", "<leader>cd", "<leader>ce",
                "]c", "[c", "<leader>cl", "cL",
                "<leader>cs", "<leader>cy", "<leader>co",
            }
            for _, lhs in ipairs(default_keymaps) do
                pcall(vim.keymap.del, "n", lhs)
            end
            pcall(vim.keymap.del, "v", "<leader>ca")
        end,
    },
}