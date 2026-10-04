local config = vim.json.decode(table.concat(vim.fn.readfile(arg[1]), "\n"))
vim.opt.runtimepath:prepend(config.plugin)
vim.opt.runtimepath:prepend(config.repository .. "/home/.config/nvim")
vim.o.shadafile = "NONE"
vim.o.swapfile = false
vim.o.columns = 120
vim.o.lines = 40
local ui = require("agentic.config")
ui.windows.position = "bottom"
local function report(value)
    local file = assert(io.open(config.report, "a"))
    file:write(vim.json.encode(value), "\n")
    file:close()
end
local client = require("sodium.agency.client").new({ executable = config.executable })
local state = require("sodium.agency.state").new(config.projection_limits)
local views, listeners, stream, done, annotation_hooks = {}, {}, nil, false, 0
local function notify()
    for callback in pairs(listeners) do
        callback()
    end
end
local function request(body, callback)
    stream.request(body, function(err, frame)
        callback(err or (frame and not frame.ok and frame.error) or nil, frame and frame.receipt)
    end)
end
local controller = {
    snapshot = state.current,
    limits = config.view_limits,
    subscribe = function(callback)
        listeners[callback] = true
        return function()
            listeners[callback] = nil
        end
    end,
    submit = function(id, text, callback)
        request({ op = "submit", submissionId = id, text = text }, callback)
    end,
    inspect = function(id, callback)
        request({ op = "inspect-submission", submissionId = id }, callback)
    end,
    confirm_external = function(_, _, callback)
        callback(true)
    end,
    accept_annotations = function()
        annotation_hooks = annotation_hooks + 1
    end,
}
local function evidence(id)
    local snapshot = state.current()
    local value = { id = id, hooks = annotation_hooks, retention = state.retention(), views = {} }
    if snapshot then
        value.target = snapshot.target
        value.firstSeq, value.lastSeq = snapshot.firstSeq, snapshot.lastSeq
        value.historyTruncated = snapshot.historyTruncated
        value.turn = snapshot.currentTurn
        value.metadata = snapshot.metadata
        value.replay = 0
        value.userBytes, value.answerBytes = 0, 0
        for _, event in ipairs(snapshot.events) do
            if event.kind == "update" then
                value.replay = value.replay + (event.replay and 1 or 0)
                local update = event.update
                if update.sessionUpdate == "agent_message_chunk" then
                    value.answerBytes = value.answerBytes + #update.content.text
                elseif update.sessionUpdate == "user_message_chunk" then
                    value.userBytes = value.userBytes + #update.content.text
                end
            end
        end
    end
    for i, view in ipairs(views) do
        value.views[i] = view.renderer.metrics()
    end
    if views[1] then
        local text = table.concat(vim.api.nvim_buf_get_lines(views[1].widget.buf_nrs.chat, 0, -1, false), "\n")
        value.transcript = text:sub(-16384)
        value.draft = table.concat(vim.api.nvim_buf_get_lines(views[1].widget.buf_nrs.input, 0, -1, false), "\n")
    end
    return value
end
local function clean()
    for _, view in ipairs(views) do
        view.destroy()
    end
    client.close()
end
local function dispatch(command)
    local function emit(value)
        value.id = command.id
        report(value)
    end
    if command.op == "submit" then
        local text = command.text or string.rep("x", command.bytes)
        vim.api.nvim_buf_set_lines(views[1].widget.buf_nrs.input, 0, -1, false, vim.split(text, "\n", { plain = true }))
        views[1].submit(function(result)
            result.submissionId = result.submissionId or views[1].status().submissionId
            emit(result)
        end)
    elseif command.op == "request" then
        request(command.body, function(err, receipt)
            emit({ receipt = receipt, failure = err })
        end)
    elseif command.op == "wait" then
        local deadline = vim.uv.now() + 35000
        local function poll()
            local snapshot = state.current()
            local turn = snapshot and snapshot.currentTurn
            if turn and turn ~= vim.NIL and turn.submissionId == command.submissionId and (turn.state == "completed" or turn.state == "failed") then
                vim.schedule(function()
                    local result = evidence(command.id)
                    result.state = turn.state
                    report(result)
                end)
            elseif vim.uv.now() > deadline then
                emit({ error = "turn timed out" })
            else
                vim.defer_fn(poll, 20)
            end
        end
        poll()
    elseif command.op == "snapshot" then
        report(evidence(command.id))
    elseif command.op == "hide" then
        views[command.view or 1].hide()
        report(evidence(command.id))
    elseif command.op == "show" then
        views[command.view or 1].show()
        report(evidence(command.id))
    elseif command.op == "draft" then
        vim.api.nvim_buf_set_lines(views[command.view or 1].widget.buf_nrs.input, 0, -1, false, { command.text })
        report(evidence(command.id))
    elseif command.op == "command" then
        client.command(command.argv, { cwd = command.cwd }, function(err, result)
            emit({ failure = err, result = result })
        end)
    elseif command.op == "exit" then
        clean()
        emit({ exited = true })
        done = true
    else
        emit({ error = "unknown fixture operation" })
    end
end
stream = client.attach(config.target, {
    on_frame = function(frame, bytes)
        if frame.type == "snapshot_begin" then
            state.begin_snapshot(frame, bytes)
        elseif frame.type == "snapshot_events" then
            state.add_snapshot_events(frame, bytes)
        elseif frame.type == "snapshot_end" then
            state.end_snapshot(frame, bytes)
            for i = 1, 2 do
                views[i] = require("sodium.agency.agentic_view").new(vim.api.nvim_get_current_tabpage(), controller)
            end
            views[1].show()
            report(evidence(0))
        elseif frame.type == "event" then
            state.apply_event(frame)
        end
        notify()
    end,
    on_fault = function(err)
        state.disconnect(err)
        notify()
        report({ id = -1, fault = err })
    end,
})
local input, buffer = assert(vim.uv.new_pipe(false)), ""
assert(input:open(0))
input:read_start(function(err, bytes)
    if err then
        report({ id = -2, error = err })
        return
    end
    if not bytes then
        vim.schedule(function()
            clean()
            done = true
        end)
        return
    end
    buffer = buffer .. bytes
    while buffer:find("\n", 1, true) do
        local index = buffer:find("\n", 1, true)
        local line = buffer:sub(1, index - 1)
        buffer = buffer:sub(index + 1)
        vim.schedule(function()
            local ok, failure = pcall(dispatch, vim.json.decode(line))
            if not ok then
                report({ id = vim.json.decode(line).id, error = tostring(failure) })
            end
        end)
    end
end)
vim.wait(120000, function()
    return done
end, 10)
input:read_stop()
input:close()
clean()
vim.cmd("qa!")