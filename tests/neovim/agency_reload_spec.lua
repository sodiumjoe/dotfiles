package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
dofile(vim.env.DOTFILES_TEST_ROOT .. "/home/.config/nvim/lua/sodium/plugins/agentic.lua").config()

describe("Agency reload", function()
    local f, control, Registry, calls, systems, notifications, root, digest
    before_each(function()
        f = require("fixtures.agency_native").new()
        control = require("fixtures.agency_control")
        Registry = require("agentic.session_registry")
        calls, systems, notifications, digest = {}, {}, {}, string.rep("d", 64)
        root = vim.fn.tempname()
        vim.fn.mkdir(root .. "/agency/dist", "p")
        vim.fn.writefile({ vim.json.encode({ version = 1, distDigest = digest }) }, root .. "/agency/dist/build-manifest.json")
        package.loaded["sodium.agency"] = nil
        require("sodium.agency").setup({
            client = { command = function(argv, options, callback) calls[#calls + 1] = { argv = argv, options = options, callback = callback } end },
            notify = function(value) notifications[#notifications + 1] = value end,
            system = function(argv, _, on_exit) systems[#systems + 1] = argv; on_exit({ code = systems.fail and 1 or 0, stdout = "", stderr = systems.fail and "type error" or "" }); return {} end,
            repository = root,
            reconnect = function(done) f.client:_set_state("ready"); done() end,
        })
    end)
    after_each(function()
        vim.g.agency_reload_running = nil
        f.close()
        vim.fn.delete(root, "rf")
    end)

    local function respond(name, result, err)
        for _, call in ipairs(calls) do
            if not call.answered and call.argv[1] == name then
                call.answered = true
                call.callback(err, result and { handlerGeneration = control.id(2), result = result })
                f.flush()
                return call
            end
        end
        error("no pending " .. name .. " call")
    end
    local function respond_page(rows)
        for _, call in ipairs(calls) do
            if not call.answered and call.argv[1] == "agent" and call.argv[2] == "page" then
                call.answered = true
                call.callback(nil, { handlerGeneration = control.id(2), result = control.page(rows) })
                f.flush()
                return
            end
        end
        error("no pending page call")
    end
    local function answer_load(target)
        local frame = f.request("session/load")
        f.client:_handle_message({ id = frame.id, result = { sessionId = "agency:" .. target.agentId,
            _meta = { agency = { version = 1, binding = target, backendId = "codex-acp",
                configuration = { configOptions = {}, availableCommands = {} } } } } })
        f.flush()
    end
    local nothing = { state = "restarted", restarted = false, resumed = false, agents = {} }

    it("reloads the Lua twice without stacking patches or moving the tab", function()
        local tab, manager = f.manager.tab_page_id, f.manager
        for _ = 1, 2 do
            require("sodium.agency.reload").run({})
            respond("restart", nothing)
            f.flush()
            respond("status", { phase = "ready", distDigest = digest })
            respond_page({ f.row })
            answer_load(control.target_a)
        end
        assert.are.equal(2, #systems)
        assert.are.equal(manager, Registry.sessions[tab])
        for _, call in ipairs(calls) do assert.is_false(call.argv[1] == "restart" and call.argv[2] ~= "--resume") end
        f.client:_handle_message({ method = "session/update", params = { sessionId = manager.session_id,
            update = { sessionUpdate = "agent_message_chunk", content = { type = "text", text = "reload-marker" } } } })
        vim.wait(100, function() return false end)
        local text = table.concat(vim.api.nvim_buf_get_lines(manager.message_writer.bufnr, 0, -1, false), "\n")
        local _, count = text:gsub("reload%-marker", "")
        assert.are.equal(1, count)
    end)

    it("restarts an old Handler without a digest and rebinds the same tab", function()
        local tab, manager = f.manager.tab_page_id, f.manager
        local moved = vim.deepcopy(control.target_a)
        moved.handlerGeneration, moved.providerGeneration = control.id(20), control.id(21)
        local row = control.agent(moved)
        row.record.definition.cwd = vim.fn.getcwd()
        require("sodium.agency.reload").run({})
        respond("restart", nothing)
        f.flush()
        respond("status", { phase = "ready" })
        f.client:_set_state("disconnected")
        f.flush()
        respond("restart", { state = "restarted", restarted = true, resumed = true,
            agents = { { agentId = control.target_a.agentId, outcome = "restored", failure = vim.NIL } } })
        respond_page({ row })
        answer_load(moved)
        assert.are.equal(manager, Registry.sessions[tab])
        assert.are.same(moved, manager._agency_binding)
        assert.are.equal(1, #vim.api.nvim_list_tabpages())
        assert.is_truthy(table.concat(notifications, "\n"):find("Handler restarted", 1, true))
    end)

    it("reloads nothing when running turns keep the Handler busy", function()
        local before = package.loaded["sodium.agency"]
        require("sodium.agency.reload").run({ force = true })
        respond("restart", nothing)
        f.flush()
        respond("status", { phase = "ready", distDigest = digest })
        respond("restart", nil, { code = "BUSY", message = "agents still working: x" })
        assert.are.equal(before, package.loaded["sodium.agency"])
        for _, call in ipairs(calls) do assert.is_false(call.argv[1] == "agent") end
        assert.is_truthy(table.concat(notifications, "\n"):find("nothing was reloaded", 1, true))
    end)

    it("stops before reloading when the build fails", function()
        systems.fail = true
        require("sodium.agency.reload").run({})
        respond("restart", nothing)
        f.flush()
        for _, call in ipairs(calls) do assert.is_false(call.argv[1] == "status") end
        assert.is_truthy(table.concat(notifications, "\n"):find("type error", 1, true))
    end)

    it("puts the previous modules and commands back when a new module fails to load", function()
        local before = package.loaded["sodium.agency"]
        package.preload["sodium.agency.stream"] = function() error("broken stream") end
        require("sodium.agency.reload").run({})
        respond("restart", nothing)
        f.flush()
        respond("status", { phase = "ready", distDigest = digest })
        package.preload["sodium.agency.stream"] = nil
        assert.are.equal(before, package.loaded["sodium.agency"])
        assert.is_not_nil(vim.api.nvim_get_commands({})["AgencyReload"])
        assert.is_truthy(table.concat(notifications, "\n"):find("broken stream", 1, true))
    end)

    it("refuses a second reload while one is running", function()
        require("sodium.agency.reload").run({})
        require("sodium.agency.reload").run({})
        assert.is_truthy(table.concat(notifications, "\n"):find("already running", 1, true))
        local resumes = 0
        for _, call in ipairs(calls) do if call.argv[1] == "restart" then resumes = resumes + 1 end end
        assert.are.equal(1, resumes)
    end)
end)