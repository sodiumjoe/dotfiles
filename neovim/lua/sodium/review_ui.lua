local M = {}

function M.open_file_picker()
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
    if root ~= "" and filepath:sub(1, #root + 1) == root .. "/" then
        filepath = filepath:sub(#root + 2)
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
        local script = vim.env.HOME .. "/.claude/skills/neovim-review/scripts/review-approve"
        vim.notify("Submitting " .. choice:lower() .. " for PR #" .. session.id .. "...")
        vim.system({ script, choice }, { text = true }, function(result)
            vim.schedule(function()
                if result.code == 0 then
                    vim.notify("PR #" .. session.id .. " - " .. choice:lower(), vim.log.levels.INFO)
                else
                    vim.notify("Submit failed: " .. (result.stderr or ""), vim.log.levels.ERROR)
                end
            end)
        end)
    end)
end

function M.setup()
    vim.api.nvim_create_user_command("Review", function(opts)
        local base = opts.args ~= "" and opts.args or nil
        if require("sodium.review").start_self_review(base) then
            M.open_file_picker()
        end
    end, { nargs = "?" })

    vim.keymap.set("n", "<leader>pf", M.open_file_picker, { noremap = true, silent = true, desc = "Review file picker" })
    vim.keymap.set(
        "n",
        "<leader>pn",
        M.mark_reviewed_and_next,
        { noremap = true, silent = true, desc = "Mark reviewed and reopen file picker" }
    )
    vim.keymap.set("n", "<leader>pa", M.submit, { noremap = true, silent = true, desc = "Submit PR review and exit" })
end

return M
