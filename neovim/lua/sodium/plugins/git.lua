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
    local ok, _ = pcall(vim.cmd, "Gdiffsplit origin/" .. base_ref)
    if not ok then
        vim.notify("File is new in this PR (no base to diff against)", vim.log.levels.INFO)
    end
end

local function pick_pr_files()
    local pr = review.get_current_pr()
    if not pr then
        vim.notify("No PR selected. Use <leader>pr first.", vim.log.levels.WARN)
        return
    end

    vim.system(
        { "gh", "pr", "diff", tostring(pr.number), "--name-only" },
        { text = true },
        function(result)
            vim.schedule(function()
                if result.code ~= 0 then
                    vim.notify("gh pr diff failed: " .. (result.stderr or ""), vim.log.levels.ERROR)
                    return
                end
                local files = review.parse_changed_files(result.stdout)
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
                    preview = "file",
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
                    confirm = function(picker, item)
                        if not item then return end
                        picker:close()
                        local editor_win = require("sodium.utils").editor_window()
                        if editor_win then
                            vim.api.nvim_set_current_win(editor_win)
                        end
                        vim.cmd.edit(item.file)
                    end,
                    win = {
                        input = {
                            keys = {
                                ["<Tab>"] = { "toggle_reviewed", mode = { "n", "i" } },
                                ["<C-d>"] = { "open_diff", mode = { "n", "i" } },
                            },
                        },
                    },
                    actions = {
                        toggle_reviewed = function(picker)
                            local item = picker:current()
                            if not item then return end
                            review.toggle_reviewed(item.rel)
                            item.reviewed = review.is_reviewed(item.rel)
                            picker.list:update({ force = true })
                        end,
                        open_diff = function(picker)
                            local item = picker:current()
                            if not item then return end
                            picker:close()
                            open_diff(item.file, pr.baseRefName)
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
                        vim.system({ "git", "fetch", "origin", item.baseRefName })
                        pick_pr_files()
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
    local ok, _ = pcall(vim.cmd, "Gdiffsplit origin/" .. pr.baseRefName)
    if not ok then
        vim.notify("File is new in this PR (no base to diff against)", vim.log.levels.INFO)
    end
end

return {
    "tpope/vim-fugitive",
    cmd = { "Gdiffsplit", "Git" },
    keys = {
        { "<leader>pr", pick_pr, mode = "n", desc = "PR list picker" },
        { "<leader>pf", pick_pr_files, mode = "n", desc = "PR changed files picker" },
        { "<leader>pd", diff_current_file, mode = "n", desc = "Diff current file against PR base" },
        { "<leader>px", function() review.reset() vim.notify("PR review state cleared") end, mode = "n", desc = "Clear PR review state" },
    },
}