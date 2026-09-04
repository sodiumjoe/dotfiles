describe("agentic model catalog", function()
    it("normalizes Claude and Codex models", function()
        local ok, model_catalog = pcall(require, "sodium.agentic_models")
        assert.is_true(ok)

        local models = model_catalog.parse(
            [[{"models":[{"provider":"claude-agent-acp","model_id":"sonnet","name":"Sonnet","description":"Claude Sonnet"},{"provider":"codex-acp","model_id":"gpt-5.6-sol","name":"GPT-5.6 Sol","description":"Codex"}],"errors":[]}]]
        )

        assert.are.same({
            {
                provider = "claude-agent-acp",
                model_id = "sonnet",
                name = "Sonnet",
                description = "Claude Sonnet",
                text = "Claude Sonnet",
            },
            {
                provider = "codex-acp",
                model_id = "gpt-5.6-sol",
                name = "GPT-5.6 Sol",
                description = "Codex",
                text = "Codex GPT-5.6 Sol",
            },
        }, models)
    end)

    it("caches the discovered catalog", function()
        local model_catalog = require("sodium.agentic_models")
        local payload = [[{"models":[{"provider":"claude-agent-acp","model_id":"sonnet","name":"Sonnet"}],"errors":[]}]]
        local calls = 0
        local results = {}
        local system_opts
        local system = function(_, opts, on_exit)
            calls = calls + 1
            system_opts = opts
            on_exit({ code = 0, stdout = payload, stderr = "" })
        end

        model_catalog.clear_cache()
        model_catalog.discover(function(models)
            results[#results + 1] = models
        end, system)
        model_catalog.discover(function(models)
            results[#results + 1] = models
        end, system)

        vim.wait(1000, function()
            return #results == 2
        end)

        assert.are.equal(1, calls)
        assert.are.equal(2, #results)
        assert.are.equal("sonnet", results[1][1].model_id)
        assert.are.equal("sonnet", results[2][1].model_id)
        assert.are.equal(vim.fn.resolve(vim.fn.exepath("claude")), system_opts.env.CLAUDE_CODE_EXECUTABLE)
        assert.are.equal(vim.fn.resolve(vim.fn.exepath("codex")), system_opts.env.CODEX_PATH)
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

    it("reports a fallback error when the helper exits without stderr", function()
        local model_catalog = require("sodium.agentic_models")
        local errors

        model_catalog.clear_cache()
        model_catalog.discover(function(_, discovered_errors)
            errors = discovered_errors
        end, function(_, _, on_exit)
            on_exit({ code = 1 })
        end)

        vim.wait(1000, function()
            return errors ~= nil
        end)

        assert.are.same({ "Model discovery failed" }, errors)
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
