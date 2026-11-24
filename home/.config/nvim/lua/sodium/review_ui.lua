local M = {}
local agentic_utils = require("sodium.agentic_utils")
local work_bin = agentic_utils.work_bin

local function notify_agent_failure(err)
    vim.notify("Agent review failed: " .. tostring(err), vim.log.levels.ERROR)
end

function M.send_agent_command(command, session)
    local ok, result = pcall(function()
        return require("sodium.agency").submit_text(command, { session = session }, function(outcome)
            if outcome.state ~= "accepted" then
                notify_agent_failure(outcome.error and outcome.error.message or outcome.state)
            end
        end)
    end)
    if not ok then
        notify_agent_failure(result)
        return false
    end
    return result
end

function M.open_file_picker()
    local review = require("sodium.review")
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
        sort = agentic_utils.sort_by_score,
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
                M.open_diff_for_item(session, item)
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
                    require("sodium.agency.screen").focus_document()
                    utils.close_non_agentic_windows()
                    vim.cmd.edit(item.file)
                end)
            end,
        },
    })
end

function M.open_diff_for_item(session, item)
    if not item then
        return
    end
    if not item.exists then
        vim.notify(item.rel .. " not available locally", vim.log.levels.WARN)
        return
    end
    if item.untracked then
        require("sodium.agency.screen").focus_document()
        vim.cmd.edit(item.file)
        vim.notify(item.rel .. " is untracked (no base to diff)", vim.log.levels.INFO)
        return
    end
    require("sodium.diff").open({
        mode = "refs",
        file = item.file,
        left_ref = session.base_ref,
        toplevel = session.toplevel,
    })
end

function M.mark_reviewed_and_next()
    local review = require("sodium.review")
    local utils = require("sodium.utils")
    local session = review.get_session()
    if not session then
        vim.notify("No review session active", vim.log.levels.WARN)
        return
    end
    local root = session.toplevel or ""
    local filepath = vim.api.nvim_buf_get_name(0)
    if root ~= "" then
        filepath = vim.fs.relpath(root, filepath) or filepath
    end
    review.toggle_reviewed(filepath)
    local is_reviewed = review.is_reviewed(filepath)
    utils.close_non_agentic_windows()
    local marker = is_reviewed and "reviewed" or "unreviewed"
    vim.notify(filepath .. " marked " .. marker)
    M.open_file_picker()
end

function M.submit()
    local session = require("sodium.review").get_session()
    if not session then
        vim.notify("No review session active", vim.log.levels.WARN)
        return
    end
    if session.mode ~= "pr" then
        vim.notify("Not in PR mode", vim.log.levels.WARN)
        return
    end
    vim.ui.select({ "APPROVE", "REQUEST_CHANGES", "COMMENT" }, { prompt = "PR #" .. session.id .. " review:" }, function(choice)
        if not choice then
            return
        end
        local required = choice ~= "APPROVE"
        vim.ui.input({ prompt = required and "Review body: " or "Review body (optional): " }, function(body)
            if body == nil then
                return
            end
            if required and vim.trim(body) == "" then
                vim.notify("A body is required for " .. choice, vim.log.levels.WARN)
                return
            end
            vim.notify("Submitting " .. choice:lower() .. " for PR #" .. session.id .. "...")
            vim.system({ work_bin, "review", "submit", choice, body or "" }, { text = true, cwd = session.toplevel }, function(result)
                vim.schedule(function()
                    if result.code == 0 then
                        vim.notify("PR #" .. session.id .. " - " .. choice:lower(), vim.log.levels.INFO)
                    else
                        vim.notify("Submit failed: " .. (result.stderr or ""), vim.log.levels.ERROR)
                    end
                end)
            end)
        end)
    end)
end

function M.exit()
    local review = require("sodium.review")
    local session = review.get_session()
    if not session then
        vim.notify("No review session active", vim.log.levels.WARN)
        return
    end
    if session.mode ~= "pr" then
        review.reset()
        vim.notify("Self-review ended", vim.log.levels.INFO)
        return
    end
    vim.system({ work_bin, "review", "exit" }, { text = true, cwd = session.toplevel }, function(result)
        vim.schedule(function()
            if result.code == 0 then
                vim.notify("PR review ended", vim.log.levels.INFO)
            else
                vim.notify("Review exit failed: " .. (result.stderr or ""), vim.log.levels.ERROR)
            end
        end)
    end)
end

function M.pick_base_and_review()
    local review = require("sodium.review")
    local git = review.git
    local toplevel = git(vim.fn.getcwd(), { "rev-parse", "--show-toplevel" })
    if not toplevel then
        vim.notify("Not a git repository", vim.log.levels.ERROR)
        return
    end
    local base = review.detect_base(toplevel)
    if not base then
        vim.notify("Could not detect base ref", vim.log.levels.ERROR)
        return
    end
    local merge_base = git(toplevel, { "merge-base", base, "HEAD" })
    if not merge_base then
        vim.notify("Could not find merge-base for " .. base, vim.log.levels.ERROR)
        return
    end
    local log = git(toplevel, { "log", "--format=%h %s", merge_base .. "..HEAD" }) or ""
    local items = {
        {
            text = "all changes since " .. base .. " (default)",
            ref = merge_base,
            sort_idx = 1,
        },
    }
    for line in log:gmatch("[^\n]+") do
        local sha = line:match("^(%S+)")
        if sha then
            items[#items + 1] = {
                text = line .. " - from here (inclusive)",
                ref = sha .. "^",
                sort_idx = #items + 1,
            }
        end
    end

    Snacks.picker({
        title = "Review Base",
        items = items,
        preview = "none",
        layout = { hidden = { "preview" } },
        on_show = function()
            vim.cmd.stopinsert()
        end,
        sort = agentic_utils.sort_by_score,
        format = function(item)
            return { { item.text } }
        end,
        confirm = function(picker, item)
            if not item then
                return
            end
            picker:close()
            if review.start_self_review(item.ref, toplevel) then
                M.open_file_picker()
            end
        end,
    })
end

function M.show_help()
    vim.notify(table.concat({
        "<leader>rf picker",
        "<leader>rn mark reviewed and next",
        "<Tab> toggle reviewed in picker",
        "<C-o> open file without diff",
        "<leader>cc/cn/cp/cl/cd annotations",
        "<leader>ai send notes to agent",
        "<leader>ra submit PR review",
        "<leader>rx abort review",
    }, "\n"), vim.log.levels.INFO)
end

function M.setup()
    vim.api.nvim_create_user_command("Review", function(opts)
        local base = opts.args ~= "" and opts.args or nil
        local review = require("sodium.review")
        if review.start_self_review(base) then
            local session = review.get_session()
            M.show_help()
            M.send_agent_command("/neovim-review self " .. session.base_ref)
        end
    end, { nargs = "?" })

    vim.keymap.set("n", "<leader>rf", M.open_file_picker, { noremap = true, silent = true, desc = "Review file picker" })
    vim.keymap.set(
        "n",
        "<leader>rn",
        M.mark_reviewed_and_next,
        { noremap = true, silent = true, desc = "Mark reviewed and reopen file picker" }
    )
    vim.keymap.set("n", "<leader>ra", M.submit, { noremap = true, silent = true, desc = "Submit PR review and exit" })
    vim.keymap.set("n", "<leader>rx", M.exit, { noremap = true, silent = true, desc = "Exit review session" })
    vim.keymap.set(
        "n",
        "<leader>rs",
        M.pick_base_and_review,
        { noremap = true, silent = true, desc = "Pick self-review base" }
    )
    vim.keymap.set("n", "<leader>r?", M.show_help, { noremap = true, silent = true, desc = "Review keymap help" })
end

return M