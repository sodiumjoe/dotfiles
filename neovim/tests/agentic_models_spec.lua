describe("agentic model catalog", function()
    it("normalizes a provider event", function()
        local model_catalog = require("sodium.agentic_models")
        local event = model_catalog.parse_event(
            [[{"provider":"claude-agent-acp","models":[{"provider":"claude-agent-acp","model_id":"sonnet","name":"Sonnet","description":"Claude Sonnet"}]}]]
        )

        assert.are.same({
            provider = "claude-agent-acp",
            models = {
                {
                    provider = "claude-agent-acp",
                    model_id = "sonnet",
                    name = "Sonnet",
                    description = "Claude Sonnet",
                    text = "Claude Sonnet",
                },
            },
        }, event)
    end)

    it("publishes provider results from fragmented stdout", function()
        local model_catalog = require("sodium.agentic_models")
        local system_opts

        model_catalog.clear_cache()
        local updates = {}
        model_catalog.discover(function(items, complete)
            updates[#updates + 1] = { items = vim.deepcopy(items), complete = complete }
        end, function(_, opts, on_exit)
            system_opts = opts
            opts.stdout(nil, [[{"provider":"codex-acp","models":[{"provider":"codex-acp",]])
            opts.stdout(nil, [["model_id":"gpt-5.6-sol","name":"GPT-5.6 Sol"}]}]] .. "\n")
            opts.stdout(nil, [[{"provider":"claude-agent-acp","models":[]}]] .. "\n")
            on_exit({ code = 0, stderr = "" })
        end)

        vim.wait(1000, function()
            return updates[#updates] and updates[#updates].complete
        end)

        assert.is_true(#updates >= 3)
        assert.are.equal("loading", updates[1].items[1].status)
        assert.are.equal("gpt-5.6-sol", updates[#updates].items[2].model_id)
        assert.is_true(updates[#updates].complete)
        assert.are.equal(vim.fn.resolve(vim.fn.exepath("claude")), system_opts.env.CLAUDE_CODE_EXECUTABLE)
        assert.are.equal(vim.fn.resolve(vim.fn.exepath("codex")), system_opts.env.CODEX_PATH)
    end)

    it("reuses settled provider state within one Neovim process", function()
        local model_catalog = require("sodium.agentic_models")
        local calls = 0
        local first_complete = false
        local second_complete = false
        local runner = function(_, opts, on_exit)
            calls = calls + 1
            opts.stdout(nil, [[{"provider":"claude-agent-acp","models":[]}]] .. "\n")
            opts.stdout(nil, [[{"provider":"codex-acp","models":[]}]] .. "\n")
            on_exit({ code = 0, stderr = "" })
        end

        model_catalog.clear_cache()
        model_catalog.discover(function(_, complete)
            first_complete = complete
        end, runner)
        vim.wait(1000, function()
            return first_complete
        end)
        model_catalog.discover(function(_, complete)
            second_complete = complete
        end, runner)
        vim.wait(1000, function()
            return second_complete
        end)

        assert.are.equal(1, calls)
    end)

    it("opens one picker and returns the selected provider and model", function()
        local model_catalog = require("sodium.agentic_models")
        local original_discover = model_catalog.discover
        local original_snacks = _G.Snacks
        local picker_opts
        local selected

        model_catalog.discover = function(callback)
            callback({
                {
                    provider = "claude-agent-acp",
                    model_id = "sonnet",
                    name = "Sonnet",
                    text = "Claude Sonnet",
                },
                {
                    provider = "codex-acp",
                    model_id = "gpt-5.6-sol",
                    name = "GPT-5.6 Sol",
                    text = "Codex GPT-5.6 Sol",
                },
            }, {})
        end
        _G.Snacks = {
            picker = function(opts)
                picker_opts = opts
                opts.confirm({ close = function() end }, opts.items[2])
            end,
        }

        local ok, err = pcall(function()
            model_catalog.pick(function(item)
                selected = item
            end)
        end)

        model_catalog.discover = original_discover
        _G.Snacks = original_snacks
        if not ok then
            error(err)
        end

        assert.are.equal("Agent model", picker_opts.title)
        assert.are.equal(2, #picker_opts.items)
        assert.are.equal("codex-acp", selected.provider)
        assert.are.equal("gpt-5.6-sol", selected.model_id)
    end)

    it("hides the preview through the picker layout", function()
        local model_catalog = require("sodium.agentic_models")
        local original_discover = model_catalog.discover
        local original_snacks = _G.Snacks
        local picker_opts

        model_catalog.discover = function(callback)
            callback({
                {
                    provider = "claude-agent-acp",
                    model_id = "sonnet",
                    name = "Sonnet",
                    text = "Claude Sonnet",
                },
            }, {})
        end
        _G.Snacks = {
            picker = function(opts)
                picker_opts = opts
            end,
        }

        local ok, err = pcall(function()
            model_catalog.pick(function() end)
        end)

        model_catalog.discover = original_discover
        _G.Snacks = original_snacks
        if not ok then
            error(err)
        end

        assert.is_false(picker_opts.layout.preview)
    end)

    it("starts the picker in insert mode", function()
        local model_catalog = require("sodium.agentic_models")
        local original_discover = model_catalog.discover
        local original_snacks = _G.Snacks
        local original_cmd = vim.cmd
        local picker_opts
        local command

        model_catalog.discover = function(callback)
            callback({
                {
                    provider = "claude-agent-acp",
                    model_id = "sonnet",
                    name = "Sonnet",
                    text = "Claude Sonnet",
                },
            }, {})
        end
        _G.Snacks = {
            picker = function(opts)
                picker_opts = opts
            end,
        }
        vim.cmd = {
            startinsert = function()
                command = "startinsert"
            end,
            stopinsert = function()
                command = "stopinsert"
            end,
        }

        local ok, err = pcall(function()
            model_catalog.pick(function() end)
            picker_opts.on_show()
        end)

        model_catalog.discover = original_discover
        _G.Snacks = original_snacks
        vim.cmd = original_cmd
        if not ok then
            error(err)
        end

        assert.are.equal("startinsert", command)
    end)

    it("reports total discovery failure without opening a picker", function()
        local model_catalog = require("sodium.agentic_models")
        local original_discover = model_catalog.discover
        local original_notify = vim.notify
        local original_snacks = _G.Snacks
        local notification
        local picker_opened = false

        model_catalog.discover = function(callback)
            callback(nil, {
                { provider = "Claude", message = "unavailable" },
                { provider = "Codex", message = "unavailable" },
            })
        end
        vim.notify = function(message, level)
            notification = { message = message, level = level }
        end
        _G.Snacks = {
            picker = function()
                picker_opened = true
            end,
        }

        model_catalog.pick(function() end)

        model_catalog.discover = original_discover
        vim.notify = original_notify
        _G.Snacks = original_snacks

        assert.is_false(picker_opened)
        assert.are.equal(vim.log.levels.ERROR, notification.level)
        assert.are.equal("Claude: unavailable\nCodex: unavailable", notification.message)
    end)

    it("turns missing provider output into error rows", function()
        local model_catalog = require("sodium.agentic_models")
        local final_items

        model_catalog.clear_cache()
        model_catalog.discover(function(items, complete)
            if complete then
                final_items = items
            end
        end, function(_, _, on_exit)
            on_exit({ code = 1, stderr = "helper failed" })
        end)

        vim.wait(1000, function()
            return final_items ~= nil
        end)

        assert.are.equal("error", final_items[1].status)
        assert.are.equal("error", final_items[2].status)
        assert.matches("helper failed", final_items[1].name)
    end)

    it("reports a nonempty error when both catalogs are empty", function()
        local model_catalog = require("sodium.agentic_models")
        local original_discover = model_catalog.discover
        local original_notify = vim.notify
        local message

        model_catalog.discover = function(callback)
            callback({}, {})
        end
        vim.notify = function(value)
            message = value
        end

        model_catalog.pick(function() end)

        model_catalog.discover = original_discover
        vim.notify = original_notify

        assert.are.equal("No Claude or Codex models were discovered", message)
    end)
end)
