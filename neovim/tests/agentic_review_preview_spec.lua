describe("agentic PR picker preview", function()
    local function find_pick_pr_callback()
        local ok, spec = pcall(require, "sodium.plugins.agentic")
        if not ok then
            return nil
        end
        for _, key in ipairs(spec.keys or {}) do
            if type(key) == "table" and key[1] == "<leader>pr" then
                return key[2]
            end
        end
        return nil
    end

    local pick_pr = find_pick_pr_callback()

    if not pick_pr then
        return
    end

    local original_schedule
    local original_system
    local original_snacks
    local original_review

    local function setup_pr_picker()
        local picker_opts
        local diff_callback

        package.loaded["sodium.review"] = {
            parse_pr_list = function()
                return {
                    {
                        number = 7,
                        title = "Fix preview race",
                        author = "moon",
                        reviewDecision = "",
                        isDraft = false,
                    },
                }
            end,
        }

        _G.Snacks = {
            picker = function(opts)
                picker_opts = opts
            end,
        }

        vim.system = function(cmd, _, callback)
            if cmd[1] == "gh" and cmd[2] == "pr" and cmd[3] == "list" then
                callback({ code = 0, stdout = "ignored", stderr = "" })
            elseif cmd[1] == "gh" and cmd[2] == "pr" and cmd[3] == "diff" then
                diff_callback = callback
            else
                error("unexpected vim.system command: " .. table.concat(cmd, " "))
            end

            return {
                wait = function()
                    return { code = 0, stdout = "", stderr = "" }
                end,
            }
        end

        pick_pr()

        assert.is_table(picker_opts)
        return picker_opts, function()
            assert.is_function(diff_callback)
            return diff_callback
        end
    end

    before_each(function()
        original_schedule = vim.schedule
        original_system = vim.system
        original_snacks = _G.Snacks
        original_review = package.loaded["sodium.review"]
        vim.schedule = function(fn)
            fn()
        end
    end)

    after_each(function()
        vim.schedule = original_schedule
        vim.system = original_system
        _G.Snacks = original_snacks
        package.loaded["sodium.review"] = original_review
    end)

    it("skips async updates after the preview window is invalid", function()
        local picker_opts, get_diff_callback = setup_pr_picker()
        local preview_valid = true
        local set_lines_calls = 0
        local highlight_calls = 0

        picker_opts.preview({
            item = { number = 7 },
            picker = {
                current = function()
                    return { number = 7 }
                end,
            },
            preview = {
                win = {
                    valid = function()
                        return preview_valid
                    end,
                },
                set_lines = function(_, _)
                    set_lines_calls = set_lines_calls + 1
                    if not preview_valid then
                        error("stale preview update")
                    end
                end,
                highlight = function()
                    highlight_calls = highlight_calls + 1
                    if not preview_valid then
                        error("stale preview highlight")
                    end
                end,
            },
        })

        preview_valid = false

        assert.has_no.errors(function()
            get_diff_callback()({ code = 0, stdout = "diff --git a/a.lua b/a.lua\n+ok\n", stderr = "" })
        end)
        assert.are.equal(1, set_lines_calls)
        assert.are.equal(0, highlight_calls)
    end)

    it("applies async updates while the preview window is still valid", function()
        local picker_opts, get_diff_callback = setup_pr_picker()
        local set_lines_calls = 0
        local highlight_calls = 0
        local last_lines

        picker_opts.preview({
            item = { number = 7 },
            picker = {
                current = function()
                    return { number = 7 }
                end,
            },
            preview = {
                win = {
                    valid = function()
                        return true
                    end,
                },
                set_lines = function(_, lines)
                    set_lines_calls = set_lines_calls + 1
                    last_lines = lines
                end,
                highlight = function(_, opts)
                    highlight_calls = highlight_calls + 1
                    assert.are.same({ ft = "diff" }, opts)
                end,
            },
        })

        get_diff_callback()({ code = 0, stdout = "line 1\nline 2", stderr = "" })

        assert.are.equal(2, set_lines_calls)
        assert.are.equal(1, highlight_calls)
        assert.are.same({ "line 1", "line 2" }, last_lines)
    end)
end)
