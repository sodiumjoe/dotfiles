local M = {}
local Context = require("sodium.agency.context")

local function busy(snapshot)
    local turn = snapshot and snapshot.currentTurn
    return turn and turn ~= vim.NIL and (turn.state == "accepted" or turn.state == "running") or false
end

function M.new(tab, controller)
    local api = { dirty = false }
    local destroyed, epoch, pending, files = false, 0, nil, {}
    local delivery = "idle"
    local widget = require("sodium.agency.widget").new(tab, function()
        api.submit()
    end)
    api.widget = widget
    api.renderer = require("sodium.agency.render").new(widget, controller.snapshot, controller.limits)
    local function changed(name, component)
        local values = name == "code" and component:get_selections()
            or name == "files" and component:get_files()
            or component:get_diagnostics()
        widget.render_header(name, tostring(#values) .. " items")
        if widget.is_open() then
            widget.show()
        end
    end
    api.code = require("agentic.ui.code_selection"):new(widget.buf_nrs.code, function(value)
        changed("code", value)
    end)
    api.files = require("agentic.ui.file_list"):new(widget.buf_nrs.files, function(value)
        changed("files", value)
    end)
    api.diagnostics = require("agentic.ui.diagnostics_list"):new(widget.buf_nrs.diagnostics, function(value)
        changed("diagnostics", value)
    end)
    local function clear_matching(component, captured, getter, add)
        local current, remaining = component[getter](component), {}
        for _, value in ipairs(current) do
            local matched = false
            for _, submitted in ipairs(captured) do
                if vim.deep_equal(value, submitted) then
                    matched = true
                    break
                end
            end
            if not matched then
                remaining[#remaining + 1] = value
            end
        end
        component:clear()
        for _, value in ipairs(remaining) do
            component[add](component, value)
        end
    end
    local function accepted(receipt)
        if not pending or pending.accepted or receipt.submissionId ~= pending.id then
            return
        end
        pending.accepted = true
        delivery = "accepted"
        local buf = widget.buf_nrs.input
        if vim.api.nvim_buf_is_valid(buf) and vim.api.nvim_buf_get_changedtick(buf) == pending.tick then
            vim.api.nvim_buf_set_lines(buf, 0, -1, false, {})
        end
        clear_matching(api.code, pending.selections, "get_selections", "add")
        clear_matching(api.files, pending.paths, "get_files", "add")
        clear_matching(api.diagnostics, pending.diagnostics, "get_diagnostics", "add")
        for key, value in pairs(pending.files) do
            if vim.deep_equal(files[key], value) then
                files[key] = nil
            end
        end
        if controller.accept_annotations then
            controller.accept_annotations(pending.annotations)
        end
    end
    local function reconcile(snapshot)
        local turn = snapshot and snapshot.currentTurn
        if pending and turn and turn ~= vim.NIL and turn.submissionId == pending.id then
            accepted(turn)
        end
    end
    local function render()
        local snapshot = controller.snapshot()
        reconcile(snapshot)
        if not snapshot or not widget.is_open() then
            return
        end
        local renderer = api.renderer
        if
            not renderer.renderFirstSeq
            or snapshot.firstSeq > renderer.renderFirstSeq
            or snapshot.lastSeq < renderer.lastSeq
        then
            renderer.compact(snapshot)
        else
            for _, event in ipairs(snapshot.events) do
                if event.seq > renderer.lastSeq then
                    renderer.event(event, { replay = event.replay })
                end
            end
        end
        widget.render_header(
            "chat",
            snapshot.selection.modelId .. " · " .. snapshot.cwd .. (snapshot.connected and "" or " · disconnected")
        )
        renderer.animate(busy(snapshot))
    end
    local function schedule()
        if destroyed then
            return
        end
        reconcile(controller.snapshot())
        if not widget.is_open() or api.dirty then
            return
        end
        api.dirty = true
        local generation = epoch
        vim.schedule(function()
            if destroyed or generation ~= epoch then
                return
            end
            api.dirty = false
            render()
        end)
    end
    local unsubscribe = controller.subscribe(schedule)
    widget.on_hide = function()
        epoch = epoch + 1
        api.dirty = false
        api.renderer.release()
    end
    function api.show(opts)
        if destroyed then
            return
        end
        widget.show(opts)
        api.renderer.reset(controller.snapshot())
        render()
    end
    function api.hide()
        widget.hide()
    end
    function api.toggle()
        if widget.is_open() then
            api.hide()
        else
            api.show({ focus_prompt = true })
        end
    end
    function api.add_context(captured, kind)
        if destroyed then
            return
        end
        captured = vim.deepcopy(captured)
        if kind == "diagnostics" then
            api.diagnostics:add_many(captured.diagnostics)
        elseif captured.selection then
            local selection = captured.selection
            selection.file_path = selection.file_path or ("[buffer:" .. captured.buffer .. "]")
            api.code:add(selection)
        else
            local key = captured.path or ("[buffer:" .. captured.buffer .. "]")
            files[key] = captured
            if captured.path and api.files:add(captured.path) then
                return
            end
            local selection = {
                buffer = captured.buffer,
                file_path = key,
                file_type = captured.file_type,
                start_line = 1,
                end_line = #captured.lines,
                lines = captured.lines,
                binary = captured.binary,
            }
            api.code:add(selection)
        end
    end
    function api.submit(callback)
        callback = callback
            or function(result)
                if result.error then
                    vim.notify("Agency: " .. result.error.message, vim.log.levels.WARN)
                end
            end
        local snapshot = controller.snapshot()
        if
            destroyed
            or not snapshot
            or not snapshot.connected
            or busy(snapshot)
            or (pending and not pending.accepted)
        then
            callback({
                state = "rejected",
                error = { code = "NOT_READY", message = "Agency delivery pending, disconnected, or turn busy" },
            })
            return
        end
        local buf = widget.buf_nrs.input
        local paths, captured_files = api.files:get_files(), {}
        for _, filename in ipairs(paths) do
            captured_files[#captured_files + 1] = vim.deepcopy(files[filename] or { path = filename })
        end
        local selections, diagnostics = api.code:get_selections(), api.diagnostics:get_diagnostics()
        local annotations = controller.annotations and controller.annotations() or {}
        local tick = vim.api.nvim_buf_get_changedtick(buf)
        local text, err = Context.encode(
            { text = table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), "\n"), files = captured_files },
            selections,
            diagnostics,
            annotations
        )
        if not text then
            callback({ state = "rejected", error = err })
            return
        end
        local value = {
            id = (controller.uuid or require("sodium.agency.client").uuid)(),
            tick = tick,
            text = text,
            selections = selections,
            paths = paths,
            diagnostics = diagnostics,
            annotations = vim.deepcopy(annotations),
            files = vim.deepcopy(files),
            target = vim.deepcopy(snapshot.target),
        }
        pending, delivery = value, "confirming"
        local items = vim.list_extend(vim.deepcopy(captured_files), vim.deepcopy(selections))
        vim.list_extend(items, diagnostics)
        local confirm = controller.confirm_external or Context.confirm_external
        confirm(snapshot.cwd, items, function(confirmed)
            if destroyed or pending ~= value then
                return
            end
            if not confirmed then
                pending = nil
                delivery = "rejected"
                callback({ state = "rejected" })
                return
            end
            delivery = "pending"
            controller.submit(value.id, text, function(error, receipt)
                if destroyed or pending ~= value then
                    return
                end
                if value.settled then
                    return
                end
                value.settled = true
                if value.accepted then
                    callback({ state = "accepted", receipt = receipt, submissionId = value.id })
                elseif not error and receipt and receipt.submissionId == value.id then
                    accepted(receipt)
                    callback({ state = "accepted", receipt = receipt })
                elseif
                    error
                    and (
                        error.rejected
                        or vim.tbl_contains(
                            { "INPUT_TOO_LARGE", "NOT_READY", "STALE_HANDLER", "STALE_PROVIDER" },
                            error.code
                        )
                    )
                then
                    pending = nil
                    delivery = "rejected"
                    callback({ state = "rejected", error = error })
                else
                    delivery = "unknown"
                    callback({ state = "unknown", submissionId = value.id, error = error })
                end
            end)
        end)
    end
    function api.inspect(callback)
        if pending and controller.inspect then
            controller.inspect(pending.id, function(err, receipt)
                if not destroyed and not err and receipt and receipt ~= vim.NIL then
                    accepted(receipt)
                end
                if callback then
                    callback(err, receipt)
                end
            end)
        end
    end
    function api.status()
        return {
            delivery = delivery,
            submissionId = pending and pending.id,
            busy = busy(controller.snapshot()),
            destroyed = destroyed,
        }
    end
    function api.destroy()
        if destroyed then
            return
        end
        destroyed = true
        epoch = epoch + 1
        api.dirty = false
        unsubscribe()
        api.renderer.destroy()
        widget.destroy()
    end
    widget.on_destroy = api.destroy
    return api
end

return M