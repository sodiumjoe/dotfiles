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
        vim.fn.mkdir(root .. "/node", "p")
        vim.fn.writefile({ "#!/bin/sh" }, root .. "/node/npm")
        vim.fn.setfperm(root .. "/node/npm", "rwxr-xr-x")
        package.loaded["sodium.agency"] = nil
        require("sodium.agency").setup({
            client = { command = function(argv, options, callback) calls[#calls + 1] = { argv = argv, options = options, callback = callback } end },
            notify = function(value) notifications[#notifications + 1] = value end,
            system = function(argv, _, on_exit) if systems.raise then error(systems.raise) end; systems[#systems + 1] = argv; on_exit({ code = systems.fail and 1 or 0, stdout = "", stderr = systems.fail and "type error" or "" }); return {} end,
            repository = root,
            node = root .. "/node",
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
        assert.is_nil(vim.g.agency_reload_running)
    end)

    local function failed_restart(failure, status, status_err)
        local before, tab, manager = package.loaded["sodium.agency"], f.manager.tab_page_id, f.manager
        require("sodium.agency.reload").run({ force = true })
        respond("restart", nothing)
        f.flush()
        respond("status", { phase = "ready", distDigest = digest })
        respond("restart", nil, failure)
        respond("status", status, status_err)
        respond_page({ f.row })
        answer_load(control.target_a)
        assert.are.equal(manager, Registry.sessions[tab])
        assert.is_nil(vim.g.agency_reload_running)
        return before, table.concat(notifications, "\n")
    end

    for name, status in pairs({ ["no digest"] = { phase = "ready" }, ["a different digest"] = { phase = "ready", distDigest = string.rep("e", 64) } }) do
        it("rebinds without reloading the Lua when a failed restart leaves an old Handler reporting " .. name, function()
            local before, text = failed_restart({ code = "INCOMPLETE", message = "shutdown did not complete; 1 stopped agents restored" }, status)
            assert.are.equal(before, package.loaded["sodium.agency"])
            assert.is_truthy(text:find("shutdown did not complete", 1, true))
            assert.is_truthy(text:find("Lua was not reloaded because the old Handler is still running", 1, true))
            assert.is_truthy(text:find("1 tab rebound", 1, true))
            assert.is_truthy(text:find("run :AgencyReload again", 1, true))
        end)
    end

    it("reloads the Lua and rebinds when a failed restart leaves the new Handler running", function()
        local before, text = failed_restart({ code = "INCOMPLETE", message = "the new Handler runs a different build than dist" }, { phase = "ready", distDigest = digest })
        assert.are_not.equal(before, package.loaded["sodium.agency"])
        assert.is_truthy(text:find("different build than dist", 1, true))
        assert.is_truthy(text:find("reloaded Lua", 1, true))
        assert.is_truthy(text:find("1 tab rebound", 1, true))
        assert.is_truthy(text:find("run :AgencyReload again", 1, true))
    end)

    it("reloads the Lua and rebinds when the Handler is down after a failed restart", function()
        local before, text = failed_restart({ code = "UNAVAILABLE", message = "the new Handler failed to start" }, nil, { code = "UNAVAILABLE", message = "no Handler" })
        assert.are_not.equal(before, package.loaded["sodium.agency"])
        assert.is_truthy(text:find("the new Handler failed to start", 1, true))
        assert.is_truthy(text:find("1 tab rebound", 1, true))
        assert.is_truthy(text:find("run :AgencyReload again", 1, true))
    end)

    it("leaves the old Handler's upgrade instructions as the next step", function()
        local before, text = failed_restart({ code = "INCOMPLETE", message = "the running Handler predates agy restart; run agy shutdown --stop-agents once while agents are idle, then agy restart --resume" }, { phase = "ready" })
        assert.are.equal(before, package.loaded["sodium.agency"])
        assert.is_truthy(text:find("agy shutdown --stop-agents", 1, true))
        assert.is_falsy(text:find("run :AgencyReload again", 1, true))
    end)

    it("still reloads when a resume restarted the Handler and the next restart is busy", function()
        local before = package.loaded["sodium.agency"]
        require("sodium.agency.reload").run({ force = true })
        respond("restart", { state = "restarted", restarted = true, resumed = true, agents = {} })
        f.flush()
        respond("status", { phase = "ready", distDigest = digest })
        respond("restart", nil, { code = "BUSY", message = "agents still working: x" })
        respond("status", { phase = "ready", distDigest = digest })
        respond_page({ f.row })
        answer_load(control.target_a)
        local text = table.concat(notifications, "\n")
        assert.are_not.equal(before, package.loaded["sodium.agency"])
        assert.is_truthy(text:find("agents still working: x", 1, true))
        assert.is_truthy(text:find("run :AgencyReload again", 1, true))
        assert.is_falsy(text:find("nothing was reloaded", 1, true))
    end)

    it("stops before reloading when the build fails", function()
        systems.fail = true
        require("sodium.agency.reload").run({})
        respond("restart", nothing)
        f.flush()
        for _, call in ipairs(calls) do assert.is_false(call.argv[1] == "status") end
        assert.is_truthy(table.concat(notifications, "\n"):find("type error", 1, true))
        assert.is_nil(vim.g.agency_reload_running)
    end)

    it("clears the running flag when npm is missing", function()
        vim.fn.delete(root .. "/node/npm")
        require("sodium.agency.reload").run({})
        respond("restart", nothing)
        f.flush()
        assert.are.equal(0, #systems)
        assert.is_nil(vim.g.agency_reload_running)
        assert.is_truthy(table.concat(notifications, "\n"):find(root .. "/node/npm is not executable", 1, true))
    end)

    it("clears the running flag when a step raises an error", function()
        systems.raise = "ENOENT: no such file or directory"
        require("sodium.agency.reload").run({})
        respond("restart", nothing)
        f.flush()
        for _, call in ipairs(calls) do assert.is_false(call.argv[1] == "status") end
        assert.is_nil(vim.g.agency_reload_running)
        assert.is_truthy(table.concat(notifications, "\n"):find("internal error: .*ENOENT"))
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
        assert.is_nil(vim.g.agency_reload_running)
    end)

    it("says so when restoring the previous modules also fails", function()
        local folds = package.loaded["sodium.agentic_folds"]
        package.loaded["sodium.agentic_folds"] = { install = function() error("old folds broken") end }
        package.preload["sodium.agency.stream"] = function() error("broken stream") end
        require("sodium.agency.reload").run({})
        respond("restart", nothing)
        f.flush()
        local ok, err = pcall(respond, "status", { phase = "ready", distDigest = digest })
        package.preload["sodium.agency.stream"] = nil
        package.loaded["sodium.agentic_folds"] = folds
        assert.is_true(ok, err)
        local text = table.concat(notifications, "\n")
        assert.is_truthy(text:find("broken stream", 1, true))
        assert.is_truthy(text:find("old folds broken", 1, true))
        assert.is_falsy(text:find("rolled back", 1, true))
        assert.is_truthy(text:find("restart Neovim", 1, true))
        assert.is_nil(vim.g.agency_reload_running)
    end)

    local function resumes()
        local count = 0
        for _, call in ipairs(calls) do if call.argv[1] == "restart" and call.argv[2] == "--resume" then count = count + 1 end end
        return count
    end

    it("does not refuse a reload after the client drops an outstanding load", function()
        require("sodium.agency.reload").run({})
        respond("restart", nothing)
        f.flush()
        respond("status", { phase = "ready", distDigest = digest })
        respond_page({ f.row })
        f.request("session/load")
        f.client:_set_state("disconnected")
        f.flush()
        notifications = {}
        require("sodium.agency.reload").run({})
        assert.is_falsy(table.concat(notifications, "\n"):find("still running", 1, true))
        assert.are.equal(2, resumes())
    end)

    it("counts a new session as busy only while its request is outstanding", function()
        f.manager:new_session()
        f.flush()
        local frame = f.request("session/new")
        require("sodium.agency.reload").run({})
        assert.is_truthy(table.concat(notifications, "\n"):find("still running", 1, true))
        assert.are.equal(0, resumes())
        f.client:_handle_message({ id = frame.id, error = { code = -32000, message = "backend failed" } })
        f.flush()
        notifications = {}
        require("sodium.agency.reload").run({})
        assert.is_falsy(table.concat(notifications, "\n"):find("still running", 1, true))
        assert.are.equal(1, resumes())
    end)

    it("refuses a second reload while one is running", function()
        require("sodium.agency.reload").run({})
        require("sodium.agency.reload").run({})
        assert.is_truthy(table.concat(notifications, "\n"):find("already running", 1, true))
        local resumes = 0
        for _, call in ipairs(calls) do if call.argv[1] == "restart" then resumes = resumes + 1 end end
        assert.are.equal(1, resumes)
    end)
    it("hides the expected connection error while it restarts the Handler", function()
        local Logger = require("agentic.utils.logger")
        local original, logged = Logger.notify, {}
        local ended = "ACP agent 'sh' failed (exit code 70):\nError: Agency Handler connection ended"
        Logger.notify = function(message) logged[#logged + 1] = message end
        local row = control.agent(control.target_a)
        row.record.definition.cwd = vim.fn.getcwd()
        require("sodium.agency.reload").run({ force = true })
        respond("restart", nothing)
        f.flush()
        respond("status", { phase = "ready", distDigest = digest })
        Logger.notify(ended, vim.log.levels.ERROR)
        Logger.notify("something else", vim.log.levels.ERROR)
        respond("restart", { state = "restarted", restarted = true, resumed = false, agents = {} })
        respond_page({ row })
        answer_load(control.target_a)
        assert.is_nil(vim.g.agency_reload_running)
        Logger.notify(ended, vim.log.levels.ERROR)
        Logger.notify = original
        assert.are.same({ "something else", ended }, logged)
    end)

    it("names config files that are not linked into the live config", function()
        vim.fn.mkdir(root .. "/home/.config/nvim/lua/sodium", "p")
        vim.fn.writefile({ "return {}" }, root .. "/home/.config/nvim/lua/sodium/linked.lua")
        vim.fn.writefile({ "return {}" }, root .. "/home/.config/nvim/lua/sodium/missing.lua")
        local config = vim.fn.tempname()
        vim.fn.mkdir(config .. "/lua/sodium", "p")
        vim.fn.writefile({ "return {}" }, config .. "/lua/sodium/linked.lua")
        require("sodium.agency").setup().deps.config = config
        require("sodium.agency.reload").run({})
        respond("restart", nothing)
        f.flush()
        respond("status", { phase = "ready", distDigest = digest })
        respond_page({ f.row })
        answer_load(control.target_a)
        local text = table.concat(notifications, "\n")
        vim.fn.delete(config, "rf")
        assert.is_truthy(text:find("1 config file is not linked into " .. config .. ": lua/sodium/missing.lua", 1, true))
        assert.is_falsy(text:find("lua/sodium/linked.lua", 1, true))
    end)
end)