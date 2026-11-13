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
    local restored, rollback_err = xpcall(function()
        local api = install(deps)
        require("sodium.agency").commands(api)
    end, debug.traceback)
    return false, err, not restored and rollback_err or nil
end

local function quiet_disconnect()
    local Logger = require("agentic.utils.logger")
    local notify = Logger.notify
    local function filtered(message, ...)
        if type(message) == "string" and message:find("Agency Handler connection ended", 1, true) then return end
        return notify(message, ...)
    end
    Logger.notify = filtered
    return function() if Logger.notify == filtered then Logger.notify = notify end end
end

local function unlinked(root, config)
    local base, missing = root .. "/home/.config/nvim", {}
    if not vim.uv.fs_stat(base) then return missing end
    for name, kind in vim.fs.dir(base, { depth = 12 }) do
        if kind == "file" and name:match("%.lua$") and not vim.uv.fs_stat(config .. "/" .. name) then missing[#missing + 1] = name end
    end
    table.sort(missing)
    return missing
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
    local parts, failed, changed, retry, restore_notify = {}, {}, false, nil, nil
    local function finish(message)
        vim.g.agency_reload_running = nil
        if restore_notify then restore_notify(); restore_notify = nil end
        if message then parts[#parts + 1] = message end
        if retry then parts[#parts + 1] = retry end
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
    local function rebind(defer_busy)
        local api = require("sodium.agency").setup()
        api.page({ allow_issues = true }, guard(function(page_err, page)
            if page_err then finish("could not list agents: " .. (page_err.message or page_err.code)); return end
            require("sodium.agency.rebind").run(page.agents, { defer_busy = defer_busy, reconnect = deps.reconnect }, guard(function(summary)
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
    local function reload(restarted)
        local config = deps.config or vim.fn.stdpath("config")
        local missing = unlinked(root, config)
        if #missing > 0 then
            local shown = table.concat(vim.list_slice(missing, 1, 5), ", ") .. (#missing > 5 and ", …" or "")
            parts[#parts + 1] = #missing == 1 and ("1 config file is not linked into " .. config .. ": " .. shown .. "; run bootstrap.sh to link it")
                or (#missing .. " config files are not linked into " .. config .. ": " .. shown .. "; run bootstrap.sh to link them")
        end
        local ok, err, rollback_err = M.reload_modules(deps)
        if not ok and rollback_err then
            finish("Lua reload failed: " .. tostring(err) .. "; restoring the previous Lua also failed: " .. tostring(rollback_err) .. "; restart Neovim")
            return
        end
        if not ok then finish("Lua reload failed and was rolled back: " .. tostring(err)); return end
        parts[#parts + 1] = "reloaded Lua"
        rebind(not restarted)
    end
    local function expected_digest() return manifest_digest(root .. "/agency/dist/build-manifest.json") end
    local function recover()
        client.command({ "status" }, {}, guard(function(err, envelope)
            local running = not err and envelope and envelope.result and envelope.result.distDigest
            if err or type(running) == "string" and running == expected_digest() then reload(false); return end
            parts[#parts + 1] = "Lua was not reloaded because the old Handler is still running"
            rebind(true)
        end))
    end
    local function restart()
        notify("Restarting the Agency Handler; it waits up to 5 minutes for running turns")
        restore_notify = quiet_disconnect()
        client.command({ "restart", "--timeout", "300" }, { timeout_ms = 1800000 }, guard(function(err, envelope)
            if err and err.code == "BUSY" and not changed then
                vim.g.agency_reload_running = nil
                if restore_notify then restore_notify(); restore_notify = nil end
                notify("Agency reload: " .. (err.message or "agents are busy") .. "; nothing was reloaded")
                return
            end
            if err then
                parts[#parts + 1] = "Handler restart failed: " .. (err.message or err.code)
                if not (err.message or ""):find("predates agy restart", 1, true) then retry = "run :AgencyReload again to finish the restart" end
                recover()
                return
            end
            parts[#parts + 1] = "Handler restarted"
            collect(envelope.result)
            reload(true)
        end))
    end
    local function check()
        client.command({ "status" }, {}, guard(function(err, envelope)
            if err then finish("status failed: " .. (err.message or err.code)); return end
            local running = envelope.result.distDigest
            if opts.force or type(running) ~= "string" or running ~= expected_digest() then restart()
            else parts[#parts + 1] = "Handler unchanged"; reload(false) end
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
            changed = envelope.result.resumed == true and envelope.result.restarted == true
            build()
        end))
    end)()
end

return M