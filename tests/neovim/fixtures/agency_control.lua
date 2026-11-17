local M = {}
function M.id(n) return string.format("00000000-0000-4000-8000-%012d", n) end
M.target_a = { agentId = M.id(1), handlerGeneration = M.id(2), providerGeneration = M.id(3) }
M.target_b = { agentId = M.id(4), handlerGeneration = M.id(2), providerGeneration = M.id(5) }
M.selection = { providerId = "codex-acp", modelId = "model-a", reasoning = { kind = "value", value = "high" }, mode = "review", permissionProfile = "fixture" }
function M.agent(target, phase)
    return { record = { version = 3, definition = { hostId = string.rep("a", 64), agentId = target.agentId, cwd = "/work/a", backendId = "codex-acp" },
        launch = vim.deepcopy(target), phase = phase or "ready", settings = { modelId = "model-a" } },
        live = (phase or "ready") == "ready", cleanup = phase == "stopped" and "verified" or "unverified" }
end
function M.row(target, live, cwd)
    return { agentId = target.agentId, backendId = "codex-acp", cwd = cwd or "/work/a", createdAt = "2026-11-14T00:00:00.000Z", title = vim.NIL, lastActivityAt = vim.NIL,
        live = live == false and vim.NIL or { activity = "idle", handlerGeneration = target.handlerGeneration, providerGeneration = target.providerGeneration, model = "model-a", mode = vim.NIL } }
end
function M.roster(rows, generation)
    return { state = "agents", handlerGeneration = generation or M.id(2), agents = rows or {} }
end
function M.page(agents, cursor, revision)
    return { state = "page", agents = agents or {}, nextCursor = cursor or vim.NIL, revision = revision or M.id(500), issues = {} }
end
function M.operations()
    local calls, opened, confirms = {}, {}, {}
    local client = { command = function(argv, options, callback) calls[#calls + 1] = { argv = argv, options = options, callback = callback } end }
    local api = require("sodium.agency.operations").new({ client = client,
        open = function(row) opened[#opened + 1] = row; return { session_id = "agency:" .. row.record.definition.agentId, on_session_ready = function(_, fn) fn() end } end,
        new_session = function(_, cb) cb(nil, "new") end,
        confirm_stop = function(target, cb) confirms[#confirms + 1] = { target = target, callback = cb } end })
    local function pending(name)
        for _, call in ipairs(calls) do
            if not call.answered and call.argv[1] == name then return call end
        end
        return nil
    end
    return { operations = api, calls = calls, opened = opened, confirms = confirms, pending = pending,
        answer = function(name, result, err, generation)
            local call = pending(name)
            if not call then error("no pending " .. name .. " call") end
            call.answered = true
            call.callback(err, result and { handlerGeneration = generation or M.id(2), result = result })
            return call
        end,
        reply = function(target, live) return { state = "agent", agent = M.row(target, live) } end }
end
function M.refresh()
    return { command = { commandId = M.id(600), state = "completed" } }
end
return M