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

    it("turns a synchronous discovery startup failure into error rows", function()
        local model_catalog = require("sodium.agentic_models")
        local original_snacks = _G.Snacks
        local picker_opts

        model_catalog.clear_cache()
        _G.Snacks = {
            picker = function(opts)
                picker_opts = opts
                return { closed = false, refresh = function() end }
            end,
        }

        local ok = pcall(function()
            model_catalog.pick(function() end, function()
                error("discovery startup failed")
            end)
        end)

        assert.is_true(ok)
        vim.wait(1000, function()
            return picker_opts.finder()[1].status == "error" and picker_opts.finder()[2].status == "error"
        end)
        assert.are.equal("error", picker_opts.finder()[1].status)
        assert.matches("discovery startup failed", picker_opts.finder()[1].name)
        assert.are.equal("error", picker_opts.finder()[2].status)
        _G.Snacks = original_snacks
    end)

    it("opens before discovery completes and refreshes for provider results", function()
        local model_catalog = require("sodium.agentic_models")
        local original_snacks = _G.Snacks
        local picker_opts
        local refreshes = 0
        local stdout
        local selected

        model_catalog.clear_cache()
        _G.Snacks = {
            picker = function(opts)
                picker_opts = opts
                return {
                    closed = false,
                    refresh = function()
                        refreshes = refreshes + 1
                    end,
                }
            end,
        }

        model_catalog.pick(function(item)
            selected = item
        end, function(_, opts)
            stdout = opts.stdout
        end)

        assert.is_not_nil(picker_opts)
        assert.are.equal("loading", picker_opts.finder()[1].status)

        local refreshes_before_output = refreshes
        stdout(nil, [[{"provider":"codex-acp","models":[{"provider":"codex-acp","model_id":"gpt-5.6-sol","name":"GPT-5.6 Sol"}]}]] .. "\n")
        vim.wait(1000, function()
            return picker_opts.finder()[2].model_id == "gpt-5.6-sol"
        end)

        assert.is_true(refreshes > refreshes_before_output)
        assert.are.equal("gpt-5.6-sol", picker_opts.finder()[2].model_id)
        picker_opts.confirm({ close = function() end }, picker_opts.finder()[2])
        assert.are.equal("codex-acp", selected.provider)
        _G.Snacks = original_snacks
    end)

    it("does not refresh a picker closed during discovery", function()
        local model_catalog = require("sodium.agentic_models")
        local original_snacks = _G.Snacks
        local picker = { closed = false, refresh = function()
            error("closed picker refreshed")
        end }
        local stdout

        model_catalog.clear_cache()
        _G.Snacks = { picker = function()
            return picker
        end }
        model_catalog.pick(function() end, function(_, opts)
            stdout = opts.stdout
        end)
        picker.closed = true
        stdout(nil, [[{"provider":"codex-acp","models":[]}]] .. "\n")
        vim.wait(50)

        _G.Snacks = original_snacks
    end)

    it("does not confirm loading or error rows", function()
        local model_catalog = require("sodium.agentic_models")
        local original_snacks = _G.Snacks
        local picker_opts
        local selected = false
        local stdout

        model_catalog.clear_cache()
        _G.Snacks = { picker = function(opts)
            picker_opts = opts
            return { closed = false, refresh = function() end }
        end }
        model_catalog.pick(function()
            selected = true
        end, function(_, opts)
            stdout = opts.stdout
        end)
        picker_opts.confirm({ close = function() end }, picker_opts.finder()[1])

        assert.is_false(selected)
        stdout(nil, [[{"provider":"claude-agent-acp","error":{"message":"unavailable"}}]] .. "\n")
        vim.wait(1000, function()
            return picker_opts.finder()[1].status == "error"
        end)
        picker_opts.confirm({ close = function() end }, picker_opts.finder()[1])

        assert.is_false(selected)
        _G.Snacks = original_snacks
    end)

    it("keeps ready provider models selectable when another provider fails", function()
        local model_catalog = require("sodium.agentic_models")
        local original_snacks = _G.Snacks
        local picker_opts
        local stdout
        local selected

        model_catalog.clear_cache()
        _G.Snacks = {
            picker = function(opts)
                picker_opts = opts
                return { closed = false, refresh = function() end }
            end,
        }

        model_catalog.pick(function(item)
            selected = item
        end, function(_, opts)
            stdout = opts.stdout
        end)
        stdout(nil, [[{"provider":"codex-acp","models":[{"provider":"codex-acp","model_id":"gpt-5.6-sol","name":"GPT-5.6 Sol"}]}]] .. "\n")
        stdout(nil, [[{"provider":"claude-agent-acp","error":{"message":"unavailable"}}]] .. "\n")

        vim.wait(1000, function()
            return picker_opts.finder()[1].status == "error" and picker_opts.finder()[2].model_id == "gpt-5.6-sol"
        end)

        assert.are.equal("error", picker_opts.finder()[1].status)
        assert.are.equal("gpt-5.6-sol", picker_opts.finder()[2].model_id)
        picker_opts.confirm({ close = function() end }, picker_opts.finder()[2])
        assert.are.equal("codex-acp", selected.provider)
        assert.are.equal("gpt-5.6-sol", selected.model_id)
        _G.Snacks = original_snacks
    end)

    it("preserves Claude-first order when Codex fails", function()
        local model_catalog = require("sodium.agentic_models")
        local original_snacks = _G.Snacks
        local picker_opts
        local stdout
        local selected

        model_catalog.clear_cache()
        _G.Snacks = {
            picker = function(opts)
                picker_opts = opts
                return { closed = false, refresh = function() end }
            end,
        }

        model_catalog.pick(function(item)
            selected = item
        end, function(_, opts)
            stdout = opts.stdout
        end)
        stdout(nil, [[{"provider":"claude-agent-acp","models":[{"provider":"claude-agent-acp","model_id":"sonnet","name":"Sonnet"}]}]] .. "\n")
        stdout(nil, [[{"provider":"codex-acp","error":{"message":"unavailable"}}]] .. "\n")

        vim.wait(1000, function()
            return picker_opts.finder()[1].model_id == "sonnet" and picker_opts.finder()[2].status == "error"
        end)

        assert.are.equal("claude-agent-acp", picker_opts.finder()[1].provider)
        assert.are.equal("sonnet", picker_opts.finder()[1].model_id)
        assert.are.equal("codex-acp", picker_opts.finder()[2].provider)
        assert.are.equal("error", picker_opts.finder()[2].status)
        picker_opts.confirm({ close = function() end }, picker_opts.finder()[1])
        assert.are.equal("claude-agent-acp", selected.provider)
        assert.are.equal("sonnet", selected.model_id)
        _G.Snacks = original_snacks
    end)

    it("hides the preview through the picker layout", function()
        local model_catalog = require("sodium.agentic_models")
        local original_snacks = _G.Snacks
        local picker_opts

        model_catalog.clear_cache()
        _G.Snacks = {
            picker = function(opts)
                picker_opts = opts
                return { closed = false, refresh = function() end }
            end,
        }

        model_catalog.pick(function() end, function() end)

        assert.is_false(picker_opts.layout.preview)
        _G.Snacks = original_snacks
    end)

    it("starts the picker in insert mode", function()
        local model_catalog = require("sodium.agentic_models")
        local original_snacks = _G.Snacks
        local original_cmd = vim.cmd
        local picker_opts
        local command

        model_catalog.clear_cache()
        _G.Snacks = {
            picker = function(opts)
                picker_opts = opts
                return { closed = false, refresh = function() end }
            end,
        }
        vim.cmd = {
            startinsert = function()
                command = "startinsert"
            end,
        }

        model_catalog.pick(function() end, function() end)
        picker_opts.on_show()

        assert.are.equal("startinsert", command)
        _G.Snacks = original_snacks
        vim.cmd = original_cmd
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

end)
