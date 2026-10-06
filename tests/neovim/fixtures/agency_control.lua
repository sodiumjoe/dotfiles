local M = {}
function M.id(n) return string.format("00000000-0000-4000-8000-%012d", n) end
M.target_a = { agentId = M.id(1), handlerGeneration = M.id(2), providerGeneration = M.id(3) }
M.target_b = { agentId = M.id(4), handlerGeneration = M.id(2), providerGeneration = M.id(5) }
M.selection = { providerId = "codex-acp", modelId = "model-a", reasoning = { kind = "value", value = "high" }, mode = "review", permissionProfile = "fixture" }
function M.agent(target, phase)
    return { record = { version = 3, definition = { agentId = target.agentId, cwd = "/work/a", backendId = "codex-acp" },
        launch = vim.deepcopy(target), phase = phase or "ready", settings = { modelId = "model-a" } },
        live = (phase or "ready") == "ready", cleanup = phase == "stopped" and "verified" or "unverified" }
end
function M.page(agents, cursor, revision)
    return { state = "page", agents = agents or {}, nextCursor = cursor or vim.NIL, revision = revision or M.id(500), issues = {} }
end
function M.operations()
    local calls, opened, reports, confirms = {}, {}, {}, {}
    local client = { command = function(argv, options, callback) calls[#calls + 1] = { argv = argv, options = options, callback = callback } end }
    local n = 700
    local api = require("sodium.agency.operations").new({ client = client, uuid = function() n = n + 1; return M.id(n) end,
        open = function(row) opened[#opened + 1] = row; return { session_id = "agency:" .. row.record.definition.agentId, on_session_ready = function(_, fn) fn() end } end,
        new_session = function(_, cb) cb(nil, "new") end,
        report = function(value) reports[#reports + 1] = value end,
        confirm_stop = function(target, cb) confirms[#confirms + 1] = { target = target, callback = cb } end })
    return { operations = api, calls = calls, opened = opened, reports = reports, confirms = confirms,
        respond = function(index, result, err, generation)
            calls[index].callback(err, result and { handlerGeneration = generation or M.id(2), result = result })
        end,
        receipt = function(index, target, outcome)
            local call = calls[index]
            local command_id
            for i, arg in ipairs(call.argv) do if arg == "--command-id" then command_id = call.argv[i + 1] end end
            return { state = "command", durability = "verified", command = { version = 3, commandId = command_id,
                handlerGeneration = M.id(2), agentId = target.agentId, state = "completed",
                result = { outcome = outcome, target = target, failure = vim.NIL } } }
        end }
end
function M.refresh()
    return { command = { commandId = M.id(600), state = "completed" } }
end
return M