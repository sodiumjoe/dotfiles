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
        transport.respond(1, control.page({ control.agent(control.target_a, "stopped") }))
        transport.respond(2, { phase = "ready" })
        assert.are.same({ "agent", "restore", restored.agentId }, vim.list_slice(transport.calls[3].argv, 1, 3))
    end
    local function restore_receipt()
        transport.respond(3, transport.receipt(3, restored, "restored"))
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
        assert.are.equal(1, #transport.calls)
        assert.is_nil(Registry.sessions[vim.api.nvim_get_current_tabpage()])
    end)

    it("opens the restored chat and reports success only after attachment readiness", function()
        local tab = vim.api.nvim_get_current_tabpage()
        begin_restore()
        assert.is_truthy(notice("restoring", restored.agentId))
        assert.is_nil(Registry.sessions[tab])
        restore_receipt()
        assert.is_truthy(notice("attaching", restored.agentId))
        assert.is_nil(notice("attached", restored.agentId))
        transport.respond(4, control.page({ control.agent(restored) }))
        f.flush()
        local manager = Registry.sessions[tab]
        assert.is_not_nil(manager)
        assert.is_true(manager.widget:is_open())
        assert.is_nil(manager.session_id)
        assert.is_nil(notice("attached", restored.agentId))
        finish_load(restored)
        assert.are.same(restored, manager._agency_binding)
        assert.are.equal("agency:" .. restored.agentId, manager.session_id)
        assert.is_truthy(notice("attached", restored.agentId))
        assert.are.equal(tab, vim.api.nvim_get_current_tabpage())
    end)

    it("keeps a newer selection when the older Restore finishes", function()
        begin_restore()
        api.attach(control.target_b.agentId)
        transport.respond(4, control.page({ control.agent(control.target_b) }))
        transport.respond(5, control.page({ control.agent(control.target_b) }))
        f.flush()
        finish_load(control.target_b)
        local tab = vim.api.nvim_get_current_tabpage()
        local manager = Registry.sessions[tab]
        restore_receipt()
        assert.are.equal(5, #transport.calls)
        assert.are.equal(manager, Registry.sessions[tab])
        assert.are.same(control.target_b, manager._agency_binding)
        assert.is_true(manager.widget:is_open())
        assert.are.equal(tab, vim.api.nvim_get_current_tabpage())
        local message = notice("restored", restored.agentId)
        assert.is_truthy(message)
        assert.is_truthy(message:find(":AgencyAttach " .. restored.agentId, 1, true))
        for _, value in ipairs(notifications) do assert.is_string(value) end
    end)

    it("explains a detached post-Restore inventory without reopening the view", function()
        begin_restore()
        restore_receipt()
        api.detach()
        transport.respond(4, control.page({ control.agent(restored) }))
        f.flush()
        assert.is_nil(Registry.sessions[vim.api.nvim_get_current_tabpage()])
        local message = notice("cancelled", restored.agentId)
        assert.is_truthy(message)
        assert.is_truthy(message:find(":AgencyAttach " .. restored.agentId, 1, true))
        assert.is_nil(notice("attached", restored.agentId))
    end)

    it("reports cancellation during initial lookup without dispatching Restore", function()
        vim.cmd("AgencyRestore " .. restored.agentId)
        api.detach()
        transport.respond(1, control.page({ control.agent(control.target_a, "stopped") }))
        assert.are.equal(1, #transport.calls)
        assert.is_truthy(notice("cancelled", restored.agentId))
        assert.is_nil(notice("restored", restored.agentId))
    end)

    it("reports cancellation during readiness lookup without dispatching Restore", function()
        vim.cmd("AgencyRestore " .. restored.agentId)
        transport.respond(1, control.page({ control.agent(control.target_a, "stopped") }))
        api.detach()
        transport.respond(2, { phase = "ready" })
        assert.are.equal(2, #transport.calls)
        assert.is_truthy(notice("cancelled", restored.agentId))
        assert.is_nil(notice("restored", restored.agentId))
    end)

    it("explains attachment failure after a successful backend Restore", function()
        begin_restore()
        restore_receipt()
        transport.respond(4, nil, { code = "UNAVAILABLE", message = "unavailable" })
        transport.respond(5, nil, { code = "UNAVAILABLE", message = "unavailable" })
        local message = notice("unavailable", restored.agentId)
        assert.is_truthy(message)
        assert.is_truthy(message:find("restored", 1, true))
        assert.is_truthy(message:find(":AgencyAttach " .. restored.agentId, 1, true))
        assert.is_nil(notice("attached", restored.agentId))
        assert.is_nil(Registry.sessions[vim.api.nvim_get_current_tabpage()])
    end)
end)