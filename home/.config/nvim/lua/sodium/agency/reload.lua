local M = {}

local extra = { "sodium.agentic_folds", "sodium.agentic_sessions" }

local function owned(name)
    return name == "sodium.agency" or name:match("^sodium%.agency%.") ~= nil or vim.tbl_contains(extra, name)
end

local function repository()
    local agy = vim.fn.exepath("agy")
    if agy == "" then return nil end
    return vim.fs.dirname(vim.fs.dirname(vim.fs.dirname(vim.fn.resolve(agy))))
end

local function manifest_digest(path)
    local ok, value = pcall(function() return vim.json.decode(table.concat(vim.fn.readfile(path), "\n")) end)
    return ok and type(value) == "table" and type(value.distDigest) == "string" and value.distDigest or nil
end

local function tail(text)
    local lines = vim.split(vim.trim(text or ""), "\n")
    return table.concat(vim.list_slice(lines, math.max(1, #lines - 20)), "\n")
end

local function install(deps)
    require("sodium.agentic_folds").install()
    require("sodium.agency.agentic").install()
    return require("sodium.agency").setup(deps)
end

function M.reload_modules(deps)
    local previous = {}
    for name, value in pairs(package.loaded) do
        if owned(name) then previous[name] = value end
    end
    for name in pairs(previous) do package.loaded[name] = nil end
    local ok, err = xpcall(function() install(deps) end, debug.traceback)
    if ok then return true end
    for name in pairs(package.loaded) do
        if owned(name) then package.loaded[name] = nil end
    end
    for name, value in pairs(previous) do package.loaded[name] = value end
    pcall(function()
        local api = install(deps)
        require("sodium.agency").commands(api)
    end)
    return false, err
end

function M.run(opts)
    opts = opts or {}
    local old = require("sodium.agency").setup()
    local notify = old.notify
    if vim.g.agency_reload_running then notify("A reload is already running"); return end
    if old.busy and old.busy() then notify("An Agency command or session load is still running; try :AgencyReload again shortly, or close a tab whose session failed to start"); return end
    local deps = old.deps or {}
    local client = deps.client or require("sodium.agency.control")
    local root = deps.repository or repository()
    if not root then notify("Cannot locate the Agency checkout from agy"); return end
    vim.g.agency_reload_running = true
    local parts, failed = {}, {}
    local function finish(message)
        vim.g.agency_reload_running = nil
        if message then parts[#parts + 1] = message end
        if #failed > 0 then parts[#parts + 1] = #failed .. " restore" .. (#failed == 1 and "" or "s") .. " failed (" .. table.concat(failed, ", ") .. ")" end
        notify("Agency reload: " .. table.concat(parts, " · "))
    end
    local function guard(fn)
        return function(...)
            local args = { n = select("#", ...), ... }
            local ok, err = xpcall(function() return fn(unpack(args, 1, args.n)) end, debug.traceback)
            if not ok then finish("internal error: " .. tostring(err)) end
        end
    end
    local function collect(result)
        for _, agent in ipairs(result and result.agents or {}) do
            if agent.outcome == "failed" then
                local failure = type(agent.failure) == "table" and (agent.failure.message or agent.failure.code) or "unknown"
                failed[#failed + 1] = agent.agentId:sub(1, 8) .. ": " .. failure
            end
        end
    end
    local function rebind(restarted)
        local ok, err = M.reload_modules(deps)
        if not ok then finish("Lua reload failed and was rolled back: " .. tostring(err)); return end
        parts[#parts + 1] = "reloaded Lua"
        local api = require("sodium.agency").setup()
        api.page({ allow_issues = true }, guard(function(page_err, page)
            if page_err then finish("could not list agents: " .. (page_err.message or page_err.code)); return end
            require("sodium.agency.rebind").run(page.agents, { defer_busy = not restarted, reconnect = deps.reconnect }, guard(function(summary)
                if summary.timed_out then finish("the editor did not reconnect to the Handler; reopen tabs with <leader>af"); return end
                local text = summary.rebound .. " tab" .. (summary.rebound == 1 and "" or "s") .. " rebound"
                if summary.deferred > 0 then text = text .. ", " .. summary.deferred .. " after their turns" end
                if #summary.missing > 0 then text = text .. ", " .. #summary.missing .. " without a running agent" end
                if #summary.failed > 0 then
                    local reasons = {}
                    for _, item in ipairs(summary.failed) do reasons[#reasons + 1] = item.agentId:sub(1, 8) .. ": " .. tostring(item.error) end
                    text = text .. ", " .. #summary.failed .. " failed to rebind (" .. table.concat(reasons, ", ") .. ")"
                end
                finish(text)
            end))
        end))
    end
    local function restart()
        notify("Restarting the Agency Handler; it waits up to 5 minutes for running turns")
        client.command({ "restart", "--timeout", "300" }, { timeout_ms = 1800000 }, guard(function(err, envelope)
            if err and err.code == "BUSY" then
                vim.g.agency_reload_running = nil
                notify("Agency reload: " .. (err.message or "agents are busy") .. "; nothing was reloaded")
                return
            end
            if err then finish("Handler restart failed: " .. (err.message or err.code) .. "; Lua was not reloaded"); return end
            parts[#parts + 1] = "Handler restarted"
            collect(envelope.result)
            rebind(true)
        end))
    end
    local function check()
        client.command({ "status" }, {}, guard(function(err, envelope)
            if err then finish("status failed: " .. (err.message or err.code)); return end
            local running = envelope.result.distDigest
            local expected = manifest_digest(root .. "/agency/dist/build-manifest.json")
            if opts.force or type(running) ~= "string" or running ~= expected then restart()
            else parts[#parts + 1] = "Handler unchanged"; rebind(false) end
        end))
    end
    local function build()
        local node = deps.node or (vim.env.NODENV_ROOT or (vim.env.HOME .. "/.nodenv")) .. "/versions/24.13.0/bin"
        local npm = node .. "/npm"
        if vim.fn.executable(npm) ~= 1 then finish("build failed: " .. npm .. " is not executable; install Node 24.13.0 with nodenv"); return end
        notify("Building Agency")
        local system = deps.system or vim.system
        system({ npm, "--prefix", root .. "/agency", "run", "build" }, { text = true, timeout = 600000, env = { PATH = node .. ":" .. (vim.env.PATH or "") } }, vim.schedule_wrap(guard(function(result)
            if result.code ~= 0 then finish("build failed:\n" .. tail((result.stdout or "") .. "\n" .. (result.stderr or ""))); return end
            parts[#parts + 1] = "built"
            check()
        end)))
    end
    guard(function()
        client.command({ "restart", "--resume" }, { timeout_ms = 1800000 }, guard(function(err, envelope)
            if err then finish("resuming a saved restore failed: " .. (err.message or err.code)); return end
            if envelope.result.resumed then parts[#parts + 1] = "resumed a saved restore"; collect(envelope.result) end
            build()
        end))
    end)()
end

return M