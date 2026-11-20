package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path

describe("Agency restore editor handoff", function()
    local f, control, transport, api, Registry, notifications, restored
    before_each(function()
        f = require("fixtures.agency_native").new()
        control = require("fixtures.agency_control")
        transport = control.operations()
        Registry = require("agentic.session_registry")
        package.loaded["sodium.agency"] = nil
        notifications = {}
        api = require("sodium.agency").setup({
            client = { command = function(argv, options, callback)
                transport.calls[#transport.calls + 1] = { argv = argv, options = options, callback = callback }
            end },
            notify = function(value) notifications[#notifications + 1] = value end,
            request = control.requests(transport.calls),
        })
        restored = vim.deepcopy(control.target_a)
        restored.providerGeneration = control.id(9)
        api.detach()
    end)
    after_each(function() f.close() end)

    local function notice(fragment, id)
        for _, value in ipairs(notifications) do
            if type(value) == "string" and value:lower():find(fragment, 1, true)
                and (not id or value:find(id, 1, true)) then return value end
        end
        return nil
    end
    local function begin_restore()
        vim.cmd("AgencyRestore " .. restored.agentId)
        assert.are.equal("agency/roster", transport.pending("agents").method)
        transport.answer("agents", control.roster({ control.row(control.target_a, false) }))
        f.flush()
        assert.is_nil(transport.pending("restore"))
    end
    local function finish_load(target)
        local frame = f.request("session/load")
        assert.are.equal("agency:" .. target.agentId, frame.params.sessionId)
        f.client:_handle_message({ id = frame.id, result = {
            sessionId = "agency:" .. target.agentId,
            _meta = { agency = { version = 1, binding = target, backendId = "codex-acp",
                configuration = { configOptions = {}, availableCommands = {} } } },
        } })
        f.flush()
    end

    it("shows pending progress before the initial inventory completes", function()
        vim.cmd("AgencyRestore " .. restored.agentId)
        assert.is_truthy(notice("restoring", restored.agentId))
        assert.is_not_nil(transport.pending("agents"))
        assert.is_nil(transport.pending("restore"))
        assert.are.same({}, Registry.list())
    end)

    it("opens the stopped agent and shows it once it loads", function()
        begin_restore()
        local manager = Registry.find_by_acp_session_id("agency:" .. restored.agentId, f.client)
        assert.is_not_nil(manager)
        finish_load(restored)
        assert.are.equal(manager, Registry.current())
        assert.is_true(manager.widget:is_open())
        assert.are.same(restored, manager._agency_binding)
        assert.are.equal("agency:" .. restored.agentId, manager.session_id)
        assert.are.equal(1, #vim.api.nvim_list_tabpages())
    end)

    it("reports cancellation during initial lookup without dispatching Restore", function()
        vim.cmd("AgencyRestore " .. restored.agentId)
        api.detach()
        transport.answer("agents", control.roster({ control.row(control.target_a, false) }))
        assert.is_nil(transport.pending("restore"))
        assert.is_truthy(notice("cancelled", restored.agentId))
        assert.is_nil(notice("restored", restored.agentId))
    end)

    it("says why a restore failed and leaves no session behind", function()
        local original, logged = vim.notify, {}
        vim.notify = function(message) logged[#logged + 1] = message end
        begin_restore()
        local manager = Registry.find_by_acp_session_id("agency:" .. restored.agentId, f.client)
        local frame = f.request("session/load")
        f.client:_handle_message({ id = frame.id, error = { code = -32000, message = "the provider did not start",
            data = { agency = { code = "FAILED", message = "the provider did not start" } } } })
        f.flush()
        vim.notify = original
        assert.are.same({ "Failed to load session: the provider did not start" }, logged)
        assert.is_true(manager._destroyed)
        assert.are.same({}, Registry.list())
        assert.is_truthy(notice("was not restored: the provider did not start", restored.agentId))
    end)
end)

describe("Agency restore on a rejected prompt", function()
    local f, control, transport, api, Registry, notifications, restored
    before_each(function()
        f = require("fixtures.agency_native").new()
        control = require("fixtures.agency_control")
        transport = control.operations()
        Registry = require("agentic.session_registry")
        package.loaded["sodium.agency"] = nil
        notifications = {}
        api = require("sodium.agency").setup({
            client = { command = function(argv, options, callback)
                transport.calls[#transport.calls + 1] = { argv = argv, options = options, callback = callback }
            end },
            notify = function(value) notifications[#notifications + 1] = value end,
            request = control.requests(transport.calls),
        })
        restored = vim.deepcopy(control.target_a)
        restored.providerGeneration = control.id(9)
    end)
    after_each(function() f.close() end)

    local function notice(fragment)
        for _, value in ipairs(notifications) do
            if type(value) == "string" and value:find(fragment, 1, true) then return value end
        end
    end
    local function reject_prompt()
        f.manager.widget.on_submit_input("hello")
        local prompt = f.request("session/prompt")
        f.client:_handle_message({ id = prompt.id, error = { code = -32000, message = "stale attachment",
            data = { agency = { code = "INVALID", message = "stale attachment" } } } })
        f.flush()
    end

    it("reattaches the session's stopped agent into a new view that keeps the draft", function()
        reject_prompt()
        local before = #f.frames
        transport.answer("agents", control.roster({ control.row(control.target_a, false) }))
        assert.is_truthy(notice("agent is stopped; restoring it"))
        f.flush()
        assert.is_nil(transport.pending("agents"))
        local frame = f.request("session/load")
        assert.are.equal(f.manager.session_id, frame.params.sessionId)
        local target = Registry.find_by_acp_session_id(f.manager.session_id, f.client)
        assert.is_not.equal(f.manager, target)
        f.client:_handle_message({ id = frame.id, result = { sessionId = "agency:" .. restored.agentId,
            _meta = { agency = { version = 1, binding = restored, backendId = "codex-acp",
                configuration = { configOptions = {}, availableCommands = {} } } } } })
        f.flush()
        assert.is_true(f.manager._destroyed)
        assert.are.equal(target, Registry.current())
        assert.is_true(target.widget:is_open())
        assert.are.same(restored, target._agency_binding)
        assert.are.same({ "hello" }, vim.api.nvim_buf_get_lines(target.widget.buf_nrs.input, 0, -1, false))
        for index = before + 1, #f.frames do assert.is_not.equal("agency/detach", f.frames[index].method) end
    end)

    it("shows the reattached session when the rejected prompt came from a hidden view", function()
        reject_prompt()
        f.manager.widget:hide()
        transport.answer("agents", control.roster({ control.row(control.target_a, false) }))
        f.flush()
        local frame = f.request("session/load")
        local target = Registry.find_by_acp_session_id(f.manager.session_id, f.client)
        f.client:_handle_message({ id = frame.id, result = { sessionId = "agency:" .. restored.agentId,
            _meta = { agency = { version = 1, binding = restored, backendId = "codex-acp",
                configuration = { configOptions = {}, availableCommands = {} } } } } })
        f.flush()
        assert.is_true(f.manager._destroyed)
        assert.are.equal(target, Registry.current())
        assert.is_true(target.widget:is_open())
    end)

    it("leaves the session alone when its agent still runs under the same binding", function()
        reject_prompt()
        transport.answer("agents", control.roster({ control.row(control.target_a) }))
        assert.is_nil(transport.pending("agents"))
        assert.is_nil(transport.pending("restore"))
        assert.is_nil(notice("restoring"))
    end)
end)