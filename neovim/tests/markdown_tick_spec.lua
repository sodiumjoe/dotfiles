describe("markdown work tick keymap", function()
    local function find_work_tick_callback()
        local ok, spec = pcall(require, "sodium.plugins.markdown")
        if not ok then
            return nil
        end

        for _, entry in ipairs(spec) do
            if type(entry) == "table" and entry.keys then
                for _, key in ipairs(entry.keys) do
                    if type(key) == "table" and key[1] == "<leader>ww" then
                        return key[2]
                    end
                end
            end
        end

        return nil
    end

    local tick_fn = find_work_tick_callback()

    if not tick_fn then
        return
    end

    local original_cmd
    local original_fn_system
    local original_notify
    local original_schedule
    local original_system
    local original_spinner

    before_each(function()
        original_cmd = vim.cmd
        original_fn_system = vim.fn.system
        original_notify = vim.notify
        original_schedule = vim.schedule
        original_system = vim.system
        original_spinner = package.loaded["sodium.spinner"]
    end)

    after_each(function()
        vim.cmd = original_cmd
        vim.fn.system = original_fn_system
        vim.notify = original_notify
        vim.schedule = original_schedule
        vim.system = original_system
        package.loaded["sodium.spinner"] = original_spinner
    end)

    it("shows tick error details from stdout when stderr is empty", function()
        local notifications = {}
        local system_calls = {}

        package.loaded["sodium.spinner"] = {
            start = function() end,
            stop = function() end,
        }

        vim.cmd = function(_) end
        vim.fn.system = function(_)
            return "exists /Users/moon/stripe/work/2026-06-08.md\n"
        end
        vim.schedule = function(fn)
            fn()
        end
        vim.notify = function(msg, level)
            table.insert(notifications, { msg = msg, level = level })
        end
        vim.system = function(cmd, _, callback)
            table.insert(system_calls, cmd)
            callback({
                code = 1,
                stdout = table.concat({
                    "2026-06-08T16:50:08.904Z ERROR tick: reviews: GHE API returned HTML instead of JSON (possible auth/connectivity issue)",
                    "",
                }, "\n"),
                stderr = "",
            })
            return {
                wait = function()
                    return { code = 1, stdout = "", stderr = "" }
                end,
            }
        end

        tick_fn()

        assert.are.equal(1, #system_calls)
        assert.are.same({ vim.env.HOME .. "/.dotfiles/work-cli/bin/work", "tick" }, system_calls[1])
        assert.are.equal(1, #notifications)
        assert.is_truthy(notifications[1].msg:find("work tick failed %(exit 1%)", 1, false))
        assert.is_truthy(
            notifications[1].msg:find("reviews: GHE API returned HTML instead of JSON", 1, false)
        )
        assert.are.equal(vim.log.levels.WARN, notifications[1].level)
    end)
end)