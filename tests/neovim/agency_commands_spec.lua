package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
describe("Agency native commands", function()
    local f, api, select_ui, snacks, notifications
    before_each(function()
        f = require("fixtures.agency_native").new()
        package.loaded["sodium.agency"] = nil
        select_ui, snacks, notifications = vim.ui.select, _G.Snacks, {}
        vim.ui.select = function(items, _, callback) callback(items[1]) end
        api = require("sodium.agency").setup({ notify = function(value) notifications[#notifications + 1] = value end })
    end)
    after_each(function() vim.ui.select = select_ui; _G.Snacks = snacks; f.close() end)
    local function respond_fast(frame, result, err)
        local done, ok, failure = false, nil, nil
        local timer = assert(vim.uv.new_timer())
        timer:start(0, 0, function()
            timer:stop(); timer:close()
            ok, failure = pcall(function()
                assert.is_true(vim.in_fast_event())
                f.client:_handle_message({ id = frame.id, result = result, error = err })
            end)
            done = true
        end)
        assert.is_true(vim.wait(1000, function() return done end))
        f.flush()
        assert.is_true(ok, failure)
    end
    local function count(method)
        local n = 0
        for _, frame in ipairs(f.frames) do if frame.method == method then n = n + 1 end end
        return n
    end
    local function choices()
        return { defaultBackendId = "codex-acp", backends = { { id = "codex-acp", discovery = "fresh", defaults = {},
            models = { { id = "model-c", name = "C", selection = { configValues = { model = "model-c" } },
                settings = { { id = "reasoning_effort", name = "Reasoning effort", kind = "config", values = { { value = "medium", name = "medium" } } } } } },
            settings = { { id = "mode", name = "Mode", kind = "config", values = { { value = "read-only", name = "Read only" } } } } } } }
    end

    it("chooses only the model and preserves configured defaults before creation", function()
        local prompts = {}
        vim.ui.select = function(items, opts, callback)
            assert.are.equal(0, count("session/new"))
            assert.is_false(vim.in_fast_event())
            prompts[#prompts + 1] = opts.prompt
            callback(items[2])
        end
        local mappings = require("sodium.plugins.agentic").keys
        local invoke
        for _, mapping in ipairs(mappings) do
            if mapping[1] == "<leader>an" then invoke = mapping[2] end
        end
        assert.is_function(invoke)
        invoke()
        f.flush()
        local result = choices()
        result.backends[1].defaults = { modeId = "agent-full-access", configValues = { reasoning_effort = "medium" } }
        respond_fast(f.request("agency/backends"), result)
        assert.are.same({ "Agency model" }, prompts)
        assert.are.same({ modeId = "agent-full-access", configValues = { model = "model-c", reasoning_effort = "medium" } }, f.request("session/new").params._meta.agency.selection)
    end)



    it("submits through native ACP and accepts annotations only on Handler admission", function()
        local accepted, outcome = 0
        api.annotations = function() return { { text = "annotation" } } end
        api.accept_annotations = function() accepted = accepted + 1 end
        assert.is_true(api.submit_text("review", { annotations = true }, function(value) outcome = value end))
        local prompt = f.request("session/prompt")
        assert.are.equal("annotation", prompt.params.prompt[#prompt.params.prompt].text)
        assert.are.equal(0, accepted)
        f.state(prompt.params._meta.agency.submissionId, "running")
        assert.are.equal(1, accepted)
        assert.are.equal("accepted", outcome.state)
    end)

    it("detaches native views without cancelling or stopping providers", function()
        f.state("shared-turn", "running")
        api.detach()
        assert.is_true(f.manager._agency_destroyed)
        for _, frame in ipairs(f.frames) do assert.is_not.equal("session/cancel", frame.method) end
    end)
end)