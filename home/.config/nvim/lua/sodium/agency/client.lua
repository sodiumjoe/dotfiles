local M = {}
local null = vim.NIL
local protocol = "agency-attachment/1"
local phases = { "starting", "ready", "recoverable", "restoring", "stopping", "stopped", "failed", "interrupted" }
local states = { "accepted", "running", "completed", "failed" }
local reasons = { "end_turn", "cancelled", "max_tokens", "max_turn_requests", "refusal" }
local codes = {
    "RESYNC_REQUIRED",
    "USAGE",
    "INVALID_PROTOCOL",
    "INVALID_AGENT_STATE",
    "STALE_HANDLER",
    "STALE_PROVIDER",
    "COMMAND_CONFLICT",
    "ADAPTER_UNQUALIFIED",
    "MODEL_UNAVAILABLE",
    "SELECTION_UNSUPPORTED",
    "CONFIG_CHANGED",
    "NOT_READY",
    "STARTUP_FAILED",
    "STARTUP_TIMEOUT",
    "AUTH_REQUIRED",
    "PERMISSION_UNSUPPORTED",
    "RESTORE_UNSUPPORTED",
    "SESSION_UNAVAILABLE",
    "CLEANUP_UNVERIFIED",
    "INCOMPLETE",
    "UNAVAILABLE",
    "INTERNAL",
    "INPUT_TOO_LARGE",
    "OUTPUT_TOO_LARGE",
    "ACP_FRAME_LIMIT",
    "ACP_HISTORY_LIMIT",
    "ACTIVE_AGENTS",
}

local function check(value)
    if not value then
        error("INVALID_PROTOCOL", 0)
    end
end

local function keys(value, required, optional)
    check(type(value) == "table")
    local allowed = {}
    for _, key in ipairs(required) do
        check(value[key] ~= nil)
        allowed[key] = true
    end
    for _, key in ipairs(optional or {}) do
        allowed[key] = true
    end
    for key in pairs(value) do
        check(allowed[key])
    end
end

local function integer(value, minimum, maximum)
    check(
        type(value) == "number"
            and value == math.floor(value)
            and value >= (minimum or 0)
            and value <= (maximum or 9007199254740991)
    )
end

local function text(value, maximum, empty)
    check(type(value) == "string" and #value <= (maximum or 256) and (empty or #value > 0))
    local index = 1
    while index <= #value do
        local start = value:find("[\128-\255]", index)
        if not start then
            break
        end
        local byte, second = value:byte(start), value:byte(start + 1)
        local length = byte >= 194 and byte <= 223 and 2
            or byte >= 224 and byte <= 239 and 3
            or byte >= 240 and byte <= 244 and 4
            or 0
        check(length > 0 and start + length - 1 <= #value)
        check(
            (byte ~= 224 or second >= 160)
                and (byte ~= 237 or second <= 159)
                and (byte ~= 240 or second >= 144)
                and (byte ~= 244 or second <= 143)
        )
        for offset = 1, length - 1 do
            local child = value:byte(start + offset)
            check(child >= 128 and child <= 191)
        end
        index = start + length
    end
end

local function id(value)
    text(value, 36)
    check(
        value:match("^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$")
            and value == value:lower()
    )
end

local function enum(value, choices)
    check(type(value) == "string" and vim.tbl_contains(choices, value))
end

local function boolean(value)
    check(type(value) == "boolean")
end
local function array(value, limit)
    check(type(value) == "table" and vim.islist(value) and #value <= limit)
end
local function hash(value)
    text(value, 64)
    check(#value == 64 and value:match("^[a-f0-9]+$"))
end
local function path(value)
    text(value, 4096)
    check(value:sub(1, 1) == "/" and not value:find("%z"))
end
local function failure(value)
    keys(value, { "code", "message" })
    enum(value.code, codes)
    text(value.message, 2048, true)
end
local function target(value)
    keys(value, { "agentId", "handlerGeneration", "providerGeneration" })
    for _, key in ipairs({ "agentId", "handlerGeneration", "providerGeneration" }) do
        id(value[key])
    end
end
local function selection(value)
    keys(value, { "providerId", "modelId", "reasoning", "mode", "permissionProfile" })
    enum(value.providerId, { "codex-acp", "claude-agent-acp" })
    text(value.modelId)
    text(value.permissionProfile)
    if value.mode ~= null then
        text(value.mode)
    end
    if value.reasoning.kind == "none" then
        keys(value.reasoning, { "kind" })
    else
        keys(value.reasoning, { "kind", "value" })
        check(value.reasoning.kind == "value")
        text(value.reasoning.value)
    end
end
local function session(value)
    keys(value, {
        "sessionId",
        "sessionGeneration",
        "protocolVersion",
        "modelId",
        "reasoning",
        "mode",
        "permissionProfile",
        "permissionEvidence",
    })
    text(value.sessionId, 1024)
    id(value.sessionGeneration)
    check(value.protocolVersion == 1)
    selection({
        providerId = "codex-acp",
        modelId = value.modelId,
        reasoning = value.reasoning,
        mode = value.mode,
        permissionProfile = value.permissionProfile,
    })
    text(value.mode)
    enum(value.permissionEvidence, { "fixture-contract-v1", "agency-deny-all-v1" })
end
local function capability(value)
    if value.state == "values" then
        keys(value, { "state", "values" })
        array(value.values, 32)
        check(#value.values > 0)
        local seen = {}
        for _, item in ipairs(value.values) do
            text(item)
            check(not seen[item])
            seen[item] = true
        end
    else
        keys(value, { "state" })
        enum(value.state, { "none", "unknown" })
    end
end
local function catalog_evidence(value)
    keys(value, {
        "providerId",
        "fingerprint",
        "verifiedAt",
        "verifiedHandlerGeneration",
        "providerVersion",
        "providerVersionSource",
        "adapterVersion",
        "sdkVersion",
        "models",
        "error",
    })
    enum(value.providerId, { "codex-acp", "claude-agent-acp" })
    hash(value.fingerprint)
    integer(value.verifiedAt)
    id(value.verifiedHandlerGeneration)
    text(value.adapterVersion)
    check(value.error == null)
    if value.sdkVersion ~= null then
        text(value.sdkVersion)
    end
    if value.providerVersion ~= null then
        text(value.providerVersion)
    end
    check(value.providerVersionSource == (value.providerVersion == null and "unknown" or "reported"))
    array(value.models, 512)
    local seen = {}
    for _, model in ipairs(value.models) do
        keys(model, { "providerId", "modelId", "resolvedModelId", "displayName", "reasoning", "modes", "availability" })
        check(model.providerId == value.providerId and model.availability == "advertised")
        text(model.modelId)
        text(model.displayName, 512)
        if model.resolvedModelId ~= null then
            text(model.resolvedModelId)
        end
        capability(model.reasoning)
        capability(model.modes)
        check(not seen[model.modelId])
        seen[model.modelId] = true
    end
end
local function launch(value, definition)
    keys(value, {
        "handlerGeneration",
        "providerGeneration",
        "launchAttemptId",
        "commandId",
        "catalogSnapshotId",
        "catalogEvidence",
        "configuration",
        "contractId",
        "contractFingerprint",
        "containment",
        "authority",
        "limits",
    })
    for _, key in ipairs({
        "handlerGeneration",
        "providerGeneration",
        "launchAttemptId",
        "commandId",
        "catalogSnapshotId",
    }) do
        id(value[key])
    end
    text(value.contractId)
    hash(value.contractFingerprint)
    check(value.containment == "direct-process-group-v1" and value.authority == "normal-user")
    check(vim.deep_equal(value.limits, {
        startupMs = 30000,
        rpcMs = 5000,
        frameBytes = 1048576,
        startupBytes = 8388608,
        writeQueueBytes = 1048576,
        stderrBytes = 8192,
    }))
    catalog_evidence(value.catalogEvidence)
    local config, evidence, chosen = value.configuration, value.catalogEvidence, definition.selection
    keys(config, { "fingerprint", "scope", "providerId", "adapterVersion", "sdkVersion" })
    hash(config.fingerprint)
    check(config.scope == "declared-config-v1")
    check(
        config.providerId == chosen.providerId
            and evidence.providerId == chosen.providerId
            and config.fingerprint == evidence.fingerprint
            and config.adapterVersion == evidence.adapterVersion
            and config.sdkVersion == evidence.sdkVersion
            and evidence.verifiedHandlerGeneration == value.handlerGeneration
    )
    local model
    for _, item in ipairs(evidence.models) do
        if item.modelId == chosen.modelId then
            model = item
            break
        end
    end
    check(model ~= nil)
    if chosen.reasoning.kind == "none" then
        check(model.reasoning.state == "none")
    else
        check(model.reasoning.state == "values" and vim.tbl_contains(model.reasoning.values, chosen.reasoning.value))
    end
    if model.modes.state == "values" then
        check(vim.tbl_contains(model.modes.values, chosen.mode))
    end
    local seen = {}
    for _, item in ipairs({
        definition.agentId,
        value.handlerGeneration,
        value.providerGeneration,
        value.launchAttemptId,
        value.commandId,
    }) do
        check(not seen[item])
        seen[item] = true
    end
    check(
        not vim.tbl_contains(
            { definition.agentId, value.handlerGeneration, value.providerGeneration, value.launchAttemptId },
            definition.createdCommandId
        )
    )
end
local function state_issue(value)
    keys(value, { "kind", "id", "path", "message" })
    enum(value.kind, { "agent", "command", "unknown" })
    if value.id ~= null then
        id(value.id)
    end
    path(value.path)
    text(value.message, 512, true)
end
local function process_identity(value)
    keys(value, { "bootId", "pid", "birth", "parentPid", "processGroupId", "sessionId", "uid", "gid" })
    text(value.bootId)
    text(value.birth, 1024)
    for _, key in ipairs({ "pid", "processGroupId", "sessionId" }) do
        integer(value[key], 1)
    end
    for _, key in ipairs({ "parentPid", "uid", "gid" }) do
        integer(value[key])
    end
end
local function process_launch(value, record)
    keys(value, {
        "version",
        "owner",
        "handlerGeneration",
        "launchAttemptId",
        "launchBootId",
        "launchAttempted",
        "phase",
        "provider",
        "reason",
    })
    check(value.version == 2)
    keys(value.owner, { "kind", "agentId", "providerGeneration" })
    check(
        value.owner.kind == "agent"
            and value.owner.agentId == record.definition.agentId
            and value.owner.providerGeneration == record.launch.providerGeneration
            and value.handlerGeneration == record.launch.handlerGeneration
            and value.launchAttemptId == record.launch.launchAttemptId
    )
    text(value.launchBootId)
    boolean(value.launchAttempted)
    enum(value.phase, {
        "launch_pending",
        "readiness",
        "active",
        "exited_unverified",
        "cleanup_pending",
        "cleanup_verified",
        "quarantined",
    })
    if value.reason ~= null then
        text(value.reason, 2048)
    end
    if value.provider ~= null then
        keys(value.provider, { "kind", "group" })
        check(value.provider.kind == "process-group")
        keys(value.provider.group, { "leader", "observed" })
        process_identity(value.provider.group.leader)
        array(value.provider.group.observed, 4096)
        for _, item in ipairs(value.provider.group.observed) do
            process_identity(item)
        end
    end
end
local function bounded_meta(value)
    check(#vim.json.encode(value) <= 65536)
end
local function content(value)
    keys(value, { "type", "text" }, { "annotations", "_meta" })
    check(value.type == "text")
    text(value.text, 1048576, true)
    if value._meta ~= nil then
        bounded_meta(value._meta)
    end
    if value.annotations ~= nil then
        keys(value.annotations, {}, { "audience", "lastModified", "priority", "_meta" })
        if value.annotations.audience ~= nil and value.annotations.audience ~= null then
            array(value.annotations.audience, 2)
            for _, role in ipairs(value.annotations.audience) do
                enum(role, { "user", "assistant" })
            end
        end
        if value.annotations.lastModified ~= nil and value.annotations.lastModified ~= null then
            text(value.annotations.lastModified, 64, true)
        end
        if value.annotations.priority ~= nil and value.annotations.priority ~= null then
            check(
                type(value.annotations.priority) == "number"
                    and value.annotations.priority == value.annotations.priority
                    and math.abs(value.annotations.priority) < math.huge
            )
        end
        bounded_meta(value.annotations)
    end
end
local function update(value)
    check(type(value) == "table")
    local kind = value.sessionUpdate
    if kind == "user_message_chunk" or kind == "agent_message_chunk" or kind == "agent_thought_chunk" then
        keys(value, { "sessionUpdate", "content" }, { "messageId", "_meta" })
        content(value.content)
        if value.messageId ~= nil and value.messageId ~= null then
            text(value.messageId, 1024)
        end
    elseif kind == "tool_call" or kind == "tool_call_update" then
        keys(
            value,
            kind == "tool_call" and { "sessionUpdate", "toolCallId", "title" } or { "sessionUpdate", "toolCallId" },
            { "title", "kind", "status", "content", "locations", "rawInput", "rawOutput", "_meta" }
        )
        text(value.toolCallId, 1024)
        check(#vim.json.encode(value) <= 1048576)
        if value.title ~= nil and value.title ~= null then
            text(value.title, 4096, true)
        end
        if value.kind ~= nil and value.kind ~= null then
            enum(
                value.kind,
                { "read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other" }
            )
        end
        if value.status ~= nil and value.status ~= null then
            enum(value.status, { "pending", "in_progress", "completed", "failed" })
        end
        if value.content ~= nil and value.content ~= null then
            array(value.content, 32)
            for _, item in ipairs(value.content) do
                if item.type == "content" then
                    keys(item, { "type", "content" }, { "_meta" })
                    content(item.content)
                elseif item.type == "diff" then
                    keys(item, { "type", "path", "newText" }, { "oldText", "_meta" })
                    text(item.path, 4096, true)
                    text(item.newText, 1048576, true)
                    if item.oldText ~= nil and item.oldText ~= null then
                        text(item.oldText, 1048576, true)
                    end
                elseif item.type == "terminal" then
                    keys(item, { "type", "terminalId" }, { "_meta" })
                    text(item.terminalId, 1024)
                else
                    check(false)
                end
                if item._meta ~= nil then
                    bounded_meta(item._meta)
                end
            end
        end
        if value.locations ~= nil and value.locations ~= null then
            array(value.locations, 64)
            for _, location in ipairs(value.locations) do
                keys(location, { "path" }, { "line", "_meta" })
                text(location.path, 4096, true)
                if location.line ~= nil and location.line ~= null then
                    integer(location.line)
                end
                if location._meta ~= nil then
                    bounded_meta(location._meta)
                end
            end
        end
        for _, key in ipairs({ "rawInput", "rawOutput" }) do
            if value[key] ~= nil then
                bounded_meta(value[key])
            end
        end
    elseif kind == "plan" then
        keys(value, { "sessionUpdate", "entries" }, { "_meta" })
        array(value.entries, 32)
        bounded_meta(value.entries)
        for _, entry in ipairs(value.entries) do
            keys(entry, { "content", "priority", "status" }, { "_meta" })
            text(entry.content, 4096, true)
            enum(entry.priority, { "high", "medium", "low" })
            enum(entry.status, { "pending", "in_progress", "completed" })
            if entry._meta ~= nil then
                bounded_meta(entry._meta)
            end
        end
    elseif kind == "session_info_update" then
        keys(value, { "sessionUpdate" }, { "title", "updatedAt", "_meta" })
        check(vim.tbl_count(value) >= 2)
        if value.title ~= nil and value.title ~= null then
            text(value.title, 1048576, true)
        end
        if value.updatedAt ~= nil and value.updatedAt ~= null then
            text(value.updatedAt, 64)
            check(value.updatedAt:match("^%d%d%d%d%-%d%d%-%d%dT%d%d:%d%d:%d%d%.%d%d%dZ$"))
        end
    elseif kind == "usage_update" then
        keys(value, { "sessionUpdate", "used", "size" }, { "cost", "_meta" })
        integer(value.used)
        integer(value.size)
        check(value.used <= value.size)
        if value.cost ~= nil and value.cost ~= null then
            keys(value.cost, { "amount", "currency" }, { "_meta" })
            check(type(value.cost.amount) == "number" and value.cost.amount >= 0 and value.cost.amount < math.huge)
            text(value.cost.currency, 3)
            check(value.cost.currency:match("^[A-Z][A-Z][A-Z]$"))
            bounded_meta(value.cost)
        end
    elseif kind == "current_mode_update" then
        keys(value, { "sessionUpdate", "currentModeId" }, { "_meta" })
        text(value.currentModeId)
    elseif kind == "config_option_update" then
        keys(value, { "sessionUpdate", "configOptions" }, { "_meta" })
        array(value.configOptions, 128)
    elseif kind == "available_commands_update" then
        keys(value, { "sessionUpdate", "availableCommands" }, { "_meta" })
        array(value.availableCommands, 128)
        bounded_meta(value.availableCommands)
        for _, command in ipairs(value.availableCommands) do
            keys(command, { "name", "description" }, { "input", "_meta" })
            text(command.name)
            text(command.description, 4096, true)
            if command.input ~= nil and command.input ~= null then
                keys(command.input, { "hint" }, { "_meta" })
                text(command.input.hint, 4096, true)
            end
            bounded_meta(command)
        end
    else
        check(false)
    end
    if value._meta ~= nil then
        bounded_meta(value._meta)
    end
end
local function turn(value, receipt)
    id(value.submissionId)
    enum(value.state, states)
    if value.stopReason ~= null then
        enum(value.stopReason, reasons)
    end
    if value.failure ~= null then
        failure(value.failure)
    end
    if value.state == "completed" then
        check(value.stopReason ~= null and value.failure == null)
    elseif value.state == "failed" then
        check(value.failure ~= null and value.stopReason == null)
    else
        check(value.failure == null and value.stopReason == null)
    end
    if receipt then
        hash(value.digest)
        integer(value.acceptedSeq, 1)
        local terminal = value.state == "completed" or value.state == "failed"
        check(terminal == (value.completedSeq ~= null))
        if terminal then
            integer(value.completedSeq, value.acceptedSeq + 1)
        end
    end
end
local function receipt(value)
    keys(value, { "submissionId", "digest", "state", "stopReason", "failure", "acceptedSeq", "completedSeq" })
    turn(value, true)
end
local function event(value)
    local common = { "kind", "seq", "encodedBytes" }
    integer(value.seq, 1)
    integer(value.encodedBytes, 1, 2097152)
    if value.kind == "submitted" then
        keys(value, vim.list_extend(common, { "submissionId", "text" }))
        id(value.submissionId)
        text(value.text, 262144)
        check(#vim.json.encode(value.text) <= 917504)
    elseif value.kind == "update" then
        keys(value, vim.list_extend(common, { "update", "replay" }))
        boolean(value.replay)
        update(value.update)
    elseif value.kind == "turn" then
        keys(value, vim.list_extend(common, { "submissionId", "state", "stopReason", "failure" }))
        turn(value)
    elseif value.kind == "lifecycle" then
        keys(value, vim.list_extend(common, { "phase" }), { "session", "selection", "cwd", "failure" })
        enum(value.phase, phases)
        if value.session ~= nil and value.session ~= null then
            session(value.session)
        end
        if value.selection ~= nil then
            selection(value.selection)
        end
        if value.cwd ~= nil then
            path(value.cwd)
        end
        if value.failure ~= nil and value.failure ~= null then
            failure(value.failure)
        end
    else
        check(false)
    end
end
local function metadata(value)
    keys(value, { "phase", "session", "selection", "cwd", "failure", "title", "plan", "planTruncated", "usage" })
    bounded_meta(value)
    enum(value.phase, phases)
    text(value.cwd, 4096, true)
    boolean(value.planTruncated)
    if value.session ~= null then
        session(value.session)
    end
    if value.selection ~= null then
        selection(value.selection)
    end
    if value.failure ~= null then
        failure(value.failure)
    end
    if value.title ~= null then
        keys(value.title, { "title", "titleTruncated", "titleOriginalBytes" })
        text(value.title.title, 1024, true)
        boolean(value.title.titleTruncated)
        integer(value.title.titleOriginalBytes, #value.title.title, 1048576)
        check(value.title.titleTruncated == (value.title.titleOriginalBytes > #value.title.title))
    end
    update({ sessionUpdate = "plan", entries = value.plan })
    if value.usage ~= null then
        local usage = vim.deepcopy(value.usage)
        usage.sessionUpdate = "usage_update"
        update(usage)
    end
end
local function boundary(value)
    integer(value.firstSeq, 1)
    integer(value.lastSeq)
    check(value.firstSeq <= value.lastSeq + 1)
    boolean(value.historyTruncated)
    check(value.historyTruncated or value.firstSeq == 1)
end
local function frame(value, expected)
    check(value.protocol == protocol)
    if value.type == "fault" and value.target == null then
    else
        target(value.target)
        check(vim.deep_equal(value.target, expected))
    end
    local base = { "protocol", "target", "type" }
    if value.type == "snapshot_begin" then
        keys(
            value,
            vim.list_extend(base, {
                "snapshotId",
                "sessionId",
                "cwd",
                "selection",
                "metadata",
                "firstSeq",
                "lastSeq",
                "historyTruncated",
                "currentTurn",
                "limits",
            })
        )
        id(value.snapshotId)
        text(value.sessionId, 1024)
        path(value.cwd)
        selection(value.selection)
        metadata(value.metadata)
        boundary(value)
        check(
            value.metadata.phase == "ready"
                and value.metadata.session.sessionId == value.sessionId
                and value.metadata.cwd == value.cwd
                and vim.deep_equal(value.metadata.selection, value.selection)
        )
        if value.currentTurn ~= null then
            keys(value.currentTurn, { "submissionId", "state" })
            id(value.currentTurn.submissionId)
            enum(value.currentTurn.state, states)
        end
        check(vim.deep_equal(value.limits, {
            inputBytes = 262144,
            outputBytes = 786432,
            encodedTextBytes = 917504,
            allowEmptyAnswer = true,
            historyBytes = 16777216,
            historyEvents = 8192,
            metadataBytes = 65536,
        }))
    elseif value.type == "snapshot_events" then
        keys(value, vim.list_extend(base, { "snapshotId", "chunkIndex", "events" }))
        id(value.snapshotId)
        integer(value.chunkIndex, 0, 8191)
        array(value.events, 8192)
        check(#value.events > 0)
        for _, item in ipairs(value.events) do
            event(item)
        end
    elseif value.type == "snapshot_end" then
        keys(value, vim.list_extend(base, { "snapshotId", "firstSeq", "lastSeq", "chunkCount", "historyTruncated" }))
        id(value.snapshotId)
        boundary(value)
        integer(value.chunkCount, 0, 8192)
    elseif value.type == "event" then
        keys(value, vim.list_extend(base, { "event", "firstSeq", "historyTruncated" }))
        event(value.event)
        integer(value.firstSeq, 1, value.event.seq + 1)
        boolean(value.historyTruncated)
        check(value.historyTruncated or value.firstSeq == 1)
    elseif value.type == "response" then
        boolean(value.ok)
        keys(value, vim.list_extend(base, { "requestId", "ok", value.ok and "receipt" or "error" }))
        id(value.requestId)
        if value.ok then
            if value.receipt ~= null then
                receipt(value.receipt)
            end
        else
            failure(value.error)
        end
    elseif value.type == "fault" then
        keys(value, vim.list_extend(base, { "error" }))
        failure(value.error)
    else
        check(false)
    end
end

local function envelope(value, argv)
    local expected = argv[1] == "agent" and "agency-agent/2"
        or argv[1] == "model" and "agency-catalog/1"
        or "agency-control/2"
    check(value.protocol == expected)
    boolean(value.ok)
    id(value.requestId)
    if value.handlerGeneration ~= null then
        id(value.handlerGeneration)
    end
    keys(
        value,
        { "protocol", "requestId", "handlerGeneration", "ok", value.ok and "result" or "error" },
        { "commandId" }
    )
    if value.commandId ~= nil then
        id(value.commandId)
    end
    if not value.ok then
        failure(value.error)
        return
    end
    local result = value.result
    check(type(result) == "table")
    if expected == "agency-control/2" then
        keys(
            result,
            { "hostId", "handlerGeneration", "phase", "reconciliation", "launches", "capabilities" },
            { "issues" }
        )
        hash(result.hostId)
        id(result.handlerGeneration)
        enum(result.phase, { "starting", "reconciling", "ready", "draining" })
        check(result.handlerGeneration == value.handlerGeneration)
        keys(result.reconciliation, { "classified", "total", "uncertain" })
        for _, key in ipairs({ "classified", "total", "uncertain" }) do
            integer(result.reconciliation[key])
        end
        check(
            result.reconciliation.classified <= result.reconciliation.total
                and result.reconciliation.uncertain <= result.reconciliation.classified
                and (result.phase ~= "ready" or result.reconciliation.classified == result.reconciliation.total)
        )
        check(vim.deep_equal(result.capabilities, { "status", "doctor", "shutdown" }))
        array(result.launches, 100000)
        for _, item in ipairs(result.launches) do
            keys(item, { "launchAttemptId", "owner", "phase", "reason" })
            text(item.launchAttemptId)
            enum(item.phase, {
                "launch_pending",
                "readiness",
                "active",
                "exited_unverified",
                "cleanup_pending",
                "cleanup_verified",
                "quarantined",
            })
            if item.reason ~= null then
                text(item.reason, 2048, true)
            end
            if item.owner.kind == "agent" then
                keys(item.owner, { "kind", "id", "generation" })
                text(item.owner.id)
                text(item.owner.generation)
            elseif item.owner.kind == "legacy-agent" then
                keys(item.owner, { "kind", "id", "handlerGeneration" })
                text(item.owner.id)
                text(item.owner.handlerGeneration)
            else
                keys(item.owner, { "kind", "id", "providerId" })
                check(item.owner.kind == "catalog-probe")
                text(item.owner.id)
                enum(item.owner.providerId, { "codex-acp", "claude-agent-acp" })
            end
        end
        if result.issues ~= nil then
            array(result.issues, 4096)
            for _, issue in ipairs(result.issues) do
                keys(issue, { "path", "launchAttemptId", "message" })
                path(issue.path)
                if issue.launchAttemptId ~= null then
                    id(issue.launchAttemptId)
                end
                text(issue.message, 8192, true)
            end
        end
        return
    end
    if expected == "agency-catalog/1" then
        enum(result.state, { "catalog", "refresh" })
        return
    end
    if argv[2] == "choices" then
        keys(result, { "state", "choices", "unavailable" })
        check(result.state == "choices")
        array(result.choices, 4096)
        array(result.unavailable, 2)
        for _, choice in ipairs(result.choices) do
            keys(choice, { "displayName", "selection", "snapshotId", "contractFingerprint" })
            text(choice.displayName)
            selection(choice.selection)
            text(choice.selection.mode)
            id(choice.snapshotId)
            hash(choice.contractFingerprint)
        end
        for _, item in ipairs(result.unavailable) do
            keys(item, { "providerId", "reason" })
            enum(item.providerId, { "codex-acp", "claude-agent-acp" })
            text(item.reason, 512)
        end
    elseif argv[2] == "page" then
        keys(result, { "state", "revision", "agents", "issues", "nextCursor" })
        check(result.state == "page")
        id(result.revision)
        array(result.agents, 100)
        array(result.issues, 100)
        check(#result.agents + #result.issues <= 100)
        if result.nextCursor ~= null then
            text(result.nextCursor, 1024)
            check(result.nextCursor:match("^[A-Za-z0-9_-]+$"))
        end
        local previous
        for _, view in ipairs(result.agents) do
            check(type(view.record) == "table")
            boolean(view.live)
            enum(view.cleanup, { "not_launched", "verified", "unverified", "unknown" })
            local record = view.record
            if record.version == 2 then
                keys(view, { "record", "launch", "live", "cleanup", "unavailable" })
                keys(record, { "version", "definition", "launch", "phase", "session", "failure" })
                keys(record.definition, { "hostId", "agentId", "createdCommandId", "cwd", "selection" })
                hash(record.definition.hostId)
                id(record.definition.agentId)
                id(record.definition.createdCommandId)
                path(record.definition.cwd)
                selection(record.definition.selection)
                text(record.definition.selection.mode)
                launch(record.launch, record.definition)
                enum(record.phase, phases)
                if record.session ~= null then
                    session(record.session)
                end
                if record.failure ~= null then
                    failure(record.failure)
                end
                if vim.tbl_contains({ "ready", "recoverable", "restoring" }, record.phase) then
                    check(record.session ~= null)
                end
                if record.phase == "starting" then
                    check(record.session == null)
                end
                if record.phase == "failed" or record.phase == "interrupted" then
                    check(record.failure ~= null)
                end
                if record.session ~= null then
                    check(
                        record.session.modelId == record.definition.selection.modelId
                            and record.session.mode == record.definition.selection.mode
                            and record.session.permissionProfile == record.definition.selection.permissionProfile
                            and vim.deep_equal(record.session.reasoning, record.definition.selection.reasoning)
                    )
                end
                if view.unavailable ~= null then
                    state_issue(view.unavailable)
                end
                if view.launch ~= null then
                    process_launch(view.launch, record)
                end
                if view.cleanup == "verified" then
                    check(view.launch ~= null and view.launch.phase == "cleanup_verified")
                end
                if view.cleanup == "not_launched" then
                    check(view.launch == null)
                end
                if view.live then
                    check(
                        record.launch.handlerGeneration == value.handlerGeneration
                            and vim.tbl_contains(
                                { "starting", "ready", "recoverable", "restoring", "stopping" },
                                record.phase
                            )
                            and (view.launch ~= null or record.phase == "starting" or record.phase == "restoring")
                            and (
                                view.launch == null
                                or not vim.tbl_contains({ "cleanup_verified", "quarantined" }, view.launch.phase)
                            )
                    )
                end
            elseif record.version == 1 then
                check(view.live == false)
                id(record.spec.agentId)
                path(record.spec.checkout.root.path)
            else
                check(false)
            end
            local agent_id = record.version == 2 and record.definition.agentId or record.spec.agentId
            check(not previous or previous < agent_id)
            previous = agent_id
        end
        for _, issue in ipairs(result.issues) do
            state_issue(issue)
        end
    else
        keys(result, { "state", "command", "durability" })
        check(result.state == "command")
        enum(result.durability, { "verified", "unverified" })
        local command = result.command
        keys(
            command,
            { "version", "hostId", "commandId", "handlerGeneration", "input", "op", "target", "state", "result" }
        )
        check(command.version == 2)
        hash(command.hostId)
        id(command.commandId)
        id(command.handlerGeneration)
        check(command.commandId == value.commandId)
        enum(command.op, { "start", "restore", "stop" })
        enum(command.state, { "pending", "completed", "interrupted" })
        if argv[2] ~= "command" then
            check(command.op == argv[2])
        end
        local supplied = {}
        for index = 1, #argv - 1 do
            if argv[index]:sub(1, 2) == "--" then
                supplied[argv[index]] = argv[index + 1]
            end
        end
        if supplied["--command-id"] then
            check(command.commandId == supplied["--command-id"])
        end
        if argv[2] == "command" then
            check(command.commandId == argv[3] and command.handlerGeneration == supplied["--handler-generation"])
        end
        if supplied["--expected-handler-generation"] then
            check(command.handlerGeneration == supplied["--expected-handler-generation"])
        end
        if command.op == "start" then
            keys(command.input, { "commandId", "handlerGeneration", "cwd", "selection", "environmentDigest" })
            path(command.input.cwd)
            selection(command.input.selection)
            hash(command.input.environmentDigest)
            if argv[2] == "start" and supplied["--model"] then
                check(
                    command.input.selection.modelId == supplied["--model"]
                        and command.input.selection.providerId == supplied["--provider"]
                        and command.input.selection.mode == supplied["--mode"]
                        and command.input.selection.permissionProfile == supplied["--permission-profile"]
                )
            end
        elseif command.op == "restore" then
            keys(command.input, { "commandId", "handlerGeneration", "agentId", "environmentDigest" })
            id(command.input.agentId)
            hash(command.input.environmentDigest)
            if argv[2] == "restore" then
                check(command.input.agentId == argv[3])
            end
        else
            keys(command.input, { "commandId", "handlerGeneration", "agentId", "providerGeneration" })
            id(command.input.agentId)
            id(command.input.providerGeneration)
            if argv[2] == "stop" then
                check(
                    command.input.agentId == argv[3]
                        and command.input.providerGeneration == supplied["--provider-generation"]
                )
            end
        end
        check(
            command.input.commandId == command.commandId
                and command.input.handlerGeneration == command.handlerGeneration
        )
        if command.target ~= null then
            target(command.target)
            check(command.target.handlerGeneration == command.handlerGeneration)
        end
        if command.op == "restore" then
            check(command.target ~= null and command.target.agentId == command.input.agentId)
        end
        if command.op == "stop" then
            check(vim.deep_equal(command.target, {
                agentId = command.input.agentId,
                handlerGeneration = command.handlerGeneration,
                providerGeneration = command.input.providerGeneration,
            }))
        end
        check((command.state == "pending") == (command.result == null))
        if command.result ~= null then
            keys(command.result, { "outcome", "target", "failure", "session" })
            enum(command.result.outcome, { "started", "restored", "stopped", "failed", "interrupted" })
            check(vim.deep_equal(command.result.target, command.target))
            if command.result.failure ~= null then
                failure(command.result.failure)
            end
            if command.result.session ~= null then
                session(command.result.session)
            end
            check(
                (command.result.outcome == "failed" or command.result.outcome == "interrupted")
                    == (command.result.failure ~= null)
            )
            if command.result.outcome == "started" or command.result.outcome == "restored" then
                check(
                    command.result.session ~= null
                        and command.target ~= null
                        and command.op == (command.result.outcome == "started" and "start" or "restore")
                )
            end
            if command.result.outcome == "stopped" then
                check(command.op == "stop" and command.target ~= null)
            end
            check((command.state == "interrupted") == (command.result.outcome == "interrupted"))
        end
    end
end

function M.uuid()
    local bytes = assert(vim.uv.random(16))
    local parts = {}
    for index = 1, 16 do
        local byte = bytes:byte(index)
        if index == 7 then
            byte = bit.bor(bit.band(byte, 15), 64)
        end
        if index == 9 then
            byte = bit.bor(bit.band(byte, 63), 128)
        end
        parts[#parts + 1] = string.format("%02x", byte)
    end
    local value = table.concat(parts)
    return value:sub(1, 8)
        .. "-"
        .. value:sub(9, 12)
        .. "-"
        .. value:sub(13, 16)
        .. "-"
        .. value:sub(17, 20)
        .. "-"
        .. value:sub(21)
end

function M.new(deps)
    deps = deps or {}
    local system, schedule, uuid = deps.system or vim.system, deps.schedule or vim.schedule, deps.uuid or M.uuid
    local defer = deps.defer
        or function(callback, ms)
            local timer = vim.uv.new_timer()
            timer:start(ms, 0, vim.schedule_wrap(callback))
            return function()
                if not timer:is_closing() then
                    timer:stop()
                    timer:close()
                end
            end
        end
    local jobs, api = {}, {}
    local executable = deps.executable or "agy"
    local function error_value(code)
        return { code = code, message = code:lower():gsub("_", " ") }
    end
    function api.command(argv, options, callback)
        options = options or {}
        local arguments = { executable }
        vim.list_extend(arguments, argv)
        arguments[#arguments + 1] = "--json"
        local parts, bytes, stderr, finished, job, cancel_timer = {}, 0, "", false
        local function finish(error, result)
            if finished then
                return
            end
            finished = true
            if cancel_timer then
                cancel_timer()
            end
            if job then
                jobs[job] = nil
            end
            parts = {}
            schedule(function()
                callback(error, result)
            end)
        end
        local function fail(code)
            if finished then
                return
            end
            if job then
                pcall(job.kill, job, 15)
            end
            finish(error_value(code))
        end
        local ok, handle = pcall(system, arguments, {
            cwd = options.cwd or vim.fn.getcwd(),
            text = false,
            stdout = function(error, chunk)
                if finished then
                    return
                end
                if error then
                    fail("UNAVAILABLE")
                    return
                end
                if chunk then
                    bytes = bytes + #chunk
                    if bytes > 8388608 then
                        fail("INVALID_PROTOCOL")
                    else
                        parts[#parts + 1] = chunk
                    end
                end
            end,
            stderr = function(_, chunk)
                if not finished and chunk then
                    stderr = (stderr .. chunk):sub(1, 8192)
                end
            end,
        }, function(result)
            if finished then
                return
            end
            local raw = #parts > 0 and table.concat(parts) or result.stdout or ""
            if #raw > 8388608 then
                finish(error_value("INVALID_PROTOCOL"))
                return
            end
            local valid, value = pcall(function()
                text(raw, 8388608)
                local decoded = vim.json.decode(raw)
                envelope(decoded, argv)
                return decoded
            end)
            if not valid then
                finish(error_value(#raw == 0 and "UNAVAILABLE" or "INVALID_PROTOCOL"))
            elseif not value.ok then
                finish(value.error, value)
            elseif result.code == 0 or result.code == 75 or (result.code == 69 and value.result.state == "page") then
                finish(nil, value)
            else
                finish(error_value("UNAVAILABLE"), value)
            end
        end)
        if not ok then
            finish(error_value("UNAVAILABLE"))
            return
        end
        job = handle
        if not finished then
            jobs[job] = function()
                fail("UNAVAILABLE")
            end
            cancel_timer = defer(function()
                fail("UNAVAILABLE")
            end, options.timeout_ms or 5000)
        end
        return {
            close = function()
                fail("UNAVAILABLE")
            end,
        }
    end
    function api.attach(tuple, handlers)
        local valid = pcall(target, tuple)
        if not valid then
            schedule(function()
                handlers.on_fault(error_value("INVALID_PROTOCOL"))
            end)
            return {
                close = function() end,
                request = function(_, callback)
                    callback(error_value("INVALID_PROTOCOL"))
                end,
            }
        end
        tuple = vim.deepcopy(tuple)
        local closed, terminal, ready, job, handshake = false, false, false
        local pending, parts, size, stderr, epoch = {}, {}, 0, "", 1
        local stage, last_seq, first_seq, truncated
        local queued, queued_bytes, scheduled = {}, 0, false
        local stream = {}
        local fault
        local function enqueue(callback, bytes)
            bytes = bytes or 0
            if queued_bytes + bytes > 4194304 then
                fault(error_value("INCOMPLETE"))
                return
            end
            queued[#queued + 1] = { callback = callback, bytes = bytes }
            queued_bytes = queued_bytes + bytes
            if scheduled then
                return
            end
            scheduled = true
            local captured = epoch
            schedule(function()
                scheduled = false
                while not closed and captured == epoch and #queued > 0 do
                    local item = table.remove(queued, 1)
                    queued_bytes = queued_bytes - item.bytes
                    item.callback()
                end
            end)
        end
        local function close()
            if closed then
                return
            end
            closed = true
            epoch = epoch + 1
            if handshake then
                handshake()
            end
            if job then
                jobs[job] = nil
                pcall(job.write, job, nil)
                pcall(job.kill, job, 15)
            end
            for _, request in pairs(pending) do
                request.cancel()
                schedule(function()
                    request.callback(error_value("UNAVAILABLE"))
                end)
            end
            pending = {}
            parts = {}
            size = 0
            queued = {}
            queued_bytes = 0
            stage = nil
        end
        fault = function(error)
            if closed or terminal then
                return
            end
            terminal = true
            enqueue(function()
                close()
                handlers.on_fault(error)
            end)
        end
        local function receive(value, wire_bytes)
            local ok = pcall(function()
                frame(value, tuple)
                if value.type == "snapshot_begin" then
                    check(not ready and not stage)
                    stage = {
                        id = value.snapshotId,
                        first = value.firstSeq,
                        last = value.lastSeq,
                        truncated = value.historyTruncated,
                        next = value.firstSeq,
                        chunks = 0,
                        bytes = wire_bytes,
                        events = 0,
                    }
                elseif value.type == "snapshot_events" then
                    check(not ready and stage and stage.id == value.snapshotId and stage.chunks == value.chunkIndex)
                    stage.chunks = stage.chunks + 1
                    stage.bytes = stage.bytes + wire_bytes
                    check(stage.bytes <= 17825792)
                    for _, item in ipairs(value.events) do
                        check(item.seq == stage.next and item.seq <= stage.last)
                        stage.next = stage.next + 1
                        stage.events = stage.events + 1
                        check(stage.events <= 8192)
                    end
                elseif value.type == "snapshot_end" then
                    check(
                        not ready
                            and stage
                            and stage.id == value.snapshotId
                            and stage.chunks == value.chunkCount
                            and stage.next == stage.last + 1
                            and stage.first == value.firstSeq
                            and stage.last == value.lastSeq
                            and stage.truncated == value.historyTruncated
                            and stage.bytes + wire_bytes <= 17825792
                    )
                    last_seq, first_seq, truncated = stage.last, stage.first, stage.truncated
                    stage = nil
                    ready = true
                    handshake()
                elseif value.type == "event" then
                    check(
                        ready
                            and value.event.seq <= last_seq + 1
                            and value.firstSeq >= first_seq
                            and (not truncated or value.historyTruncated)
                    )
                    last_seq = math.max(last_seq, value.event.seq)
                    first_seq = value.firstSeq
                    truncated = value.historyTruncated
                elseif value.type == "response" then
                    check(ready and pending[value.requestId] ~= nil)
                    local request = pending[value.requestId]
                    check(not request.responded)
                    if value.ok and value.receipt ~= null then
                        check(value.receipt.submissionId == request.submissionId)
                    end
                    request.responded = true
                    request.cancel()
                    enqueue(function()
                        pending[value.requestId] = nil
                        request.callback(value.ok and nil or value.error, value)
                    end)
                elseif value.type == "fault" then
                    fault(value.error)
                    return
                end
            end)
            if not ok then
                fault(error_value("INVALID_PROTOCOL"))
                return
            end
            if value.type ~= "response" and value.type ~= "fault" then
                enqueue(function()
                    handlers.on_frame(value, wire_bytes)
                end, math.max(wire_bytes, #vim.json.encode(value)))
            end
        end
        local ok, handle = pcall(system, {
            executable,
            "agent",
            "attach",
            tuple.agentId,
            "--handler-generation",
            tuple.handlerGeneration,
            "--provider-generation",
            tuple.providerGeneration,
            "--format",
            "ndjson",
        }, {
            text = false,
            stdin = true,
            stdout = function(error, chunk)
                if closed or terminal then
                    return
                end
                if error then
                    fault(error_value("UNAVAILABLE"))
                    return
                end
                if not chunk then
                    return
                end
                local start = 1
                while start <= #chunk and not closed and not terminal do
                    local lf = chunk:find("\n", start, true)
                    local stop = lf and lf - 1 or #chunk
                    local part = chunk:sub(start, stop)
                    size = size + #part
                    if size + 1 > 2097152 then
                        fault(error_value("INVALID_PROTOCOL"))
                        return
                    end
                    if #part > 0 then
                        parts[#parts + 1] = part
                    end
                    if not lf then
                        return
                    end
                    local raw, wire_bytes = table.concat(parts), size + 1
                    parts = {}
                    size = 0
                    start = lf + 1
                    local decoded, value = pcall(function()
                        text(raw, 2097152)
                        return vim.json.decode(raw)
                    end)
                    if not decoded then
                        fault(error_value("INVALID_PROTOCOL"))
                        return
                    end
                    receive(value, wire_bytes)
                end
            end,
            stderr = function(_, chunk)
                if not closed and chunk then
                    stderr = (stderr .. chunk):sub(1, 8192)
                end
            end,
        }, function()
            if not closed then
                fault(error_value(size > 0 and "INVALID_PROTOCOL" or "UNAVAILABLE"))
            end
        end)
        if not ok then
            fault(error_value("UNAVAILABLE"))
        else
            job = handle
            jobs[job] = close
        end
        handshake = defer(function()
            fault(error_value("UNAVAILABLE"))
        end, 5000)
        function stream.request(body, callback)
            if closed then
                schedule(function()
                    callback(error_value("UNAVAILABLE"))
                end)
                return
            end
            if closed or terminal or not ready then
                enqueue(function()
                    callback(error_value("NOT_READY"))
                end)
                return
            end
            local valid_body = pcall(function()
                enum(body.op, { "submit", "cancel", "inspect-submission" })
                id(body.submissionId)
                keys(body, body.op == "submit" and { "op", "submissionId", "text" } or { "op", "submissionId" })
                if body.op == "submit" then
                    text(body.text, 262144)
                    check(#vim.json.encode(body.text) <= 917504)
                end
            end)
            if not valid_body then
                enqueue(function()
                    callback(error_value(body.op == "submit" and "INPUT_TOO_LARGE" or "INVALID_PROTOCOL"))
                end)
                return
            end
            if vim.tbl_count(pending) >= 64 then
                enqueue(function()
                    callback(error_value("NOT_READY"))
                end)
                return
            end
            local request_id = uuid()
            local request = vim.deepcopy(body)
            request.protocol = protocol
            request.target = tuple
            request.requestId = request_id
            pending[request_id] = {
                callback = callback,
                submissionId = body.submissionId,
                cancel = defer(function()
                    fault(error_value("UNAVAILABLE"))
                end, 5000),
            }
            local written = pcall(job.write, job, vim.json.encode(request) .. "\n")
            if not written then
                fault(error_value("UNAVAILABLE"))
            end
        end
        stream.close = close
        return stream
    end
    function api.close()
        local callbacks = {}
        for _, close in pairs(jobs) do
            callbacks[#callbacks + 1] = close
        end
        for _, close in ipairs(callbacks) do
            close()
        end
    end
    return api
end

return M