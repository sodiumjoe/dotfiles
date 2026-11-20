package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
require("snacks").setup({ picker = { enabled = true } })
local List = require("sodium.agency.session_list")

describe("Agency active-agent snapshot", function()
    local pickers

    local function row(id)
        return {
            live = true,
            record = {
                version = 3,
                definition = { agentId = id, backendId = "codex-acp", cwd = "/tmp" },
                settings = {},
                phase = "ready",
                launch = { handlerGeneration = "handler", providerGeneration = "provider-" .. id },
            },
            display = { title = id },
        }
    end

    local function open(controller)
        controller.snapshot = function() return nil end
        local picker = require("sodium.agency.picker").open(controller)
        pickers[#pickers + 1] = picker
        return picker
    end

    local function settle(picker, count)
        assert.is_true(vim.wait(1000, function()
            return picker.list:count() == count and not picker:is_active()
                and picker.list.win.win ~= nil and vim.api.nvim_win_is_valid(picker.list.win.win)
        end))
    end

    before_each(function() pickers = {} end)
    after_each(function()
        for _, picker in ipairs(pickers) do picker:close() end
    end)

    local function stop_mapping(picker, window, mode)
        local buffer = picker[window].win.buf
        for _, mapping in ipairs(vim.api.nvim_buf_get_keymap(buffer, mode)) do
            if mapping.lhs:lower() == "<c-s>" then return mapping.callback end
        end
        error("missing Control-S mapping")
    end

    local function local_controller(extra)
        return vim.tbl_extend("force", {
            page = function(_, callback)
                callback(nil, { agents = { row("agent-a"), row("agent-b") }, issues = {}, handlerGeneration = "handler" })
            end,
            notify = function() end,
            attach = function() end,
        }, extra or {})
    end

    for _, context in ipairs({ { "input", "n" }, { "input", "i" }, { "list", "n" } }) do
        it("stops the highlighted row after closing windows from " .. context[1] .. " " .. context[2], function()
            local stopped, windows, closed_at_stop = {}, {}, false
            local picker = open(local_controller({ stop = function(selected)
                stopped[#stopped + 1] = selected
                closed_at_stop = true
                for _, win in ipairs(windows) do
                    if vim.api.nvim_win_is_valid(win) then closed_at_stop = false end
                end
            end }))
            settle(picker, 2)
            picker.list:view(2)
            for _, win in ipairs(picker.layout:get_wins()) do
                if win.win then windows[#windows + 1] = win.win end
                if win.backdrop and win.backdrop.win then windows[#windows + 1] = win.backdrop.win end
            end
            local selected = picker:current()
            vim.api.nvim_set_current_win(picker[context[1]].win.win)
            stop_mapping(picker, context[1], context[2])()
            selected.view.record.definition.agentId = "changed-after-selection"
            assert.is_true(vim.wait(1000, function() return #stopped == 1 end))
            assert.are.equal("agent-b", stopped[1].record.definition.agentId)
            assert.are.equal("provider-agent-b", stopped[1].record.launch.providerGeneration)
            assert.is_true(closed_at_stop)
        end)
    end

    it("cancels scheduled Stop when the guard changes", function()
        local valid, stopped = true, 0
        local picker = open(local_controller({
            selection_guard = function() return function() return valid end end,
            stop = function() stopped = stopped + 1 end,
        }))
        settle(picker, 2)
        stop_mapping(picker, "input", "n")()
        valid = false
        vim.wait(100, function() return stopped > 0 end)
        assert.are.equal(0, stopped)
    end)

    it("cancels scheduled Stop when another session becomes current", function()
        local f, control, Registry = require("fixtures.agency_native").new(), require("fixtures.agency_control"), require("agentic.session_registry")
        local ok, failure = pcall(function()
            package.loaded["sodium.agency"] = nil
            local api, stopped = require("sodium.agency").setup({ notify = function() end }), 0
            local other = api.open(control.agent(control.target_b))
            f.flush()
            local load = f.request("session/load")
            f.client:_handle_message({ id = load.id, result = { sessionId = load.params.sessionId, _meta = { agency = { version = 1,
                binding = control.target_b, backendId = "codex-acp", configuration = { configOptions = {}, availableCommands = {} } } } } })
            f.flush()
            Registry.show_session(f.manager.session_key)
            assert.are.equal(f.manager, Registry.current())
            local picker = open(local_controller({ selection_guard = api.selection_guard, stop = function() stopped = stopped + 1 end }))
            settle(picker, 2)
            stop_mapping(picker, "input", "n")()
            Registry.show_session(other.session_key)
            vim.wait(100, function() return stopped > 0 end)
            assert.are.equal(other, Registry.current())
            assert.are.equal(0, stopped)
        end)
        f.close()
        assert.is_true(ok, failure)
    end)

    it("inspects remote rows without dispatching a local Stop", function()
        local stopped, inspected = 0, {}
        local picker = open(local_controller({
            stop = function() stopped = stopped + 1 end,
            notify = function(message) inspected[#inspected + 1] = message end,
            read_roster = function(callback)
                callback(nil, { state = "roster", localHostId = "local", hosts = { {
                    hostId = "remote", hostname = "devbox", state = "ready",
                    value = { agents = { row("agent-c") }, issues = {}, handlerGeneration = "handler" },
                } } })
            end,
        }))
        settle(picker, 3)
        picker.list:view(3)
        stop_mapping(picker, "input", "n")()
        assert.are.equal(0, stopped)
        assert.are.equal(1, #inspected)
        assert.is_truthy(inspected[1]:find("agent%-c"))
        assert.is_false(picker.closed == true)
    end)

    for _, first in ipairs({ "local", "host" }) do
        it("publishes local rows without waiting for owners when " .. first .. " arrives first", function()
            local local_read, host_read
            local picker = open({
                page = function(_, callback) local_read = callback end,
                read_roster = function(callback) host_read = callback end,
            })
            local results = { agents = { row("agent-a"), row("agent-b") }, issues = {}, handlerGeneration = "handler" }
            local roster = {
                state = "roster",
                localHostId = "local",
                hosts = { {
                    hostId = "remote", hostname = "devbox", state = "ready",
                    value = { agents = { row("agent-c") }, issues = {}, handlerGeneration = "handler" },
                } },
            }
            if first == "local" then local_read(nil, results) else host_read(nil, roster) end
            if first == "local" then settle(picker, 2) else assert.are.equal(0, picker:count()) end
            if first == "local" then host_read(nil, roster) else local_read(nil, results) end
            settle(picker, 3)
            assert.are.equal("agent-a", picker.list:get(1).id)
            assert.are.equal("remote:agent-c", picker.list:get(3).id)
        end)
    end

    it("shows friendly names before long titles while retaining the SSH host and attachment identity", function()
        local remote = row("agent-c")
        remote.display.title = string.rep("Long conversation title ", 8)
        local picker = open(local_controller({
            read_roster = function(callback)
                callback(nil, { state = "roster", localHostId = "local", hosts = { {
                    hostId = "remote", hostname = "qa-worker.example", name = "climate", state = "available",
                    value = { agents = { remote }, issues = {}, handlerGeneration = "handler" },
                } } })
            end,
        }))
        settle(picker, 3)
        local item = picker.list:get(3)
        local width = vim.api.nvim_win_get_width(picker.list.win.win)
        local visible = {}
        for _, line in ipairs(vim.api.nvim_buf_get_lines(picker.list.win.buf, 0, -1, false)) do
            visible[#visible + 1] = vim.fn.strcharpart(line, 0, width)
        end
        assert.is_truthy(table.concat(visible, "\n"):find("[climate]", 1, true))
        assert.is_truthy(table.concat(item.preview, "\n"):find("Host: qa-worker.example", 1, true))
        assert.are.same({ hostId = "remote", target = {
            agentId = "agent-c", handlerGeneration = "handler", providerGeneration = "provider-agent-c",
        } }, item.remote_ref)
    end)

    local function rendered(picker)
        local lines = {}
        for _, line in ipairs(vim.api.nvim_buf_get_lines(picker.list.win.buf, 0, -1, false)) do
            if vim.trim(line) ~= "" then lines[#lines + 1] = line end
        end
        return lines
    end

    local function resize(picker, width)
        vim.api.nvim_win_set_width(picker.list.win.win, width)
        picker.list:update({ force = true })
    end

    it("shows every unavailable host on its own row, labelled by name or short hostname", function()
        local picker = open(local_controller({
            read_roster = function(callback)
                callback(nil, { state = "roster", localHostId = "local", hosts = {
                    { hostId = "remote", hostname = "qa-worker.example", name = "climate", error = "BRIDGE_EOF", state = "unavailable", code = "OFFLINE", since = 1763349120000 },
                    { hostId = "unknown-a", hostname = "unmatched-a.example", state = "unavailable", code = "UPDATE_REQUIRED" },
                    { hostId = "unknown-b", hostname = "qa-mydev--0c3af4af6e78de0a3.northwest.stripe.io", state = "unavailable", code = "OFFLINE", since = 1763349120000 },
                    { hostId = "owner", hostname = "qa-worker.example", state = "available", value = {
                        agents = {}, issues = { { message = "Owner issue" } }, handlerGeneration = "handler",
                    } },
                } })
            end,
        }))
        settle(picker, 6)
        local offline = "Offline since " .. os.date("%H:%M", 1763349120)
        local rows = {}
        for index = 1, picker:count() do
            local item = picker.list:get(index)
            rows[#rows + 1] = table.concat({ item.label, item.title, item.status }, "|")
        end
        assert.is_true(vim.tbl_contains(rows, "climate|" .. offline .. "|Offline"))
        for index = 1, picker:count() do
            local item = picker.list:get(index)
            if item.label == "climate" then assert.is_truthy(table.concat(item.preview, "\n"):find("Reason: BRIDGE_EOF", 1, true)) end
        end
        assert.is_true(vim.tbl_contains(rows, "unmatched-a|Update this devbox|Outdated"))
        assert.is_true(vim.tbl_contains(rows, "qa-mydev--0c3af4…|" .. offline .. "|Offline"))
        resize(picker, 80)
        local text = table.concat(rendered(picker), "\n")
        assert.is_falsy(text:find("unmatched-a.example", 1, true))
        assert.is_falsy(text:find("saved host", 1, true))
        for index = 1, picker:count() do
            local item = picker.list:get(index)
            if item.label == "unmatched-a" then assert.is_truthy(table.concat(item.preview, "\n"):find("Host: unmatched-a.example", 1, true)) end
        end
    end)

    it("tells an outdated devbox from one that is still connecting", function()
        local picker = open(local_controller({
            read_roster = function(callback)
                callback(nil, { state = "roster", localHostId = vim.NIL, hosts = {
                    { hostId = "old", hostname = "old.example", name = "old", state = "unavailable", code = "UPDATE_REQUIRED" },
                    { hostId = "new", hostname = "new.example", name = "new", state = "unavailable", code = "CONNECTING" },
                } })
            end,
        }))
        settle(picker, 4)
        local titles = {}
        for index = 1, picker:count() do titles[#titles + 1] = picker.list:get(index).title end
        assert.is_true(vim.tbl_contains(titles, "Update this devbox"))
        assert.is_true(vim.tbl_contains(titles, "Connecting"))
    end)

    for _, width in ipairs({ 40, 80 }) do
        it("fits aligned labels, Unicode titles and status in a " .. width .. " column list", function()
            local remote = row("agent-c")
            remote.record.settings = { configValues = { model = "gpt-6.1-sol" } }
            remote.display = { title = string.rep("界面🙂 long title ", 12) .. "uniquetitlesuffix", activity = "working" }
            local picker = open(local_controller({
                read_roster = function(callback)
                    callback(nil, { state = "roster", localHostId = "local", hosts = { {
                        hostId = "remote", hostname = "qa-worker.example", name = "stripelet-loading-migrations-production", state = "available",
                        value = { agents = { remote }, issues = {}, handlerGeneration = "handler" },
                    } } })
                end,
            }))
            settle(picker, 3)
            resize(picker, width)
            local list_width = vim.api.nvim_win_get_width(picker.list.win.win)
            local lines = rendered(picker)
            local status_column
            for _, line in ipairs(lines) do
                assert.is_true(vim.fn.strdisplaywidth(line) <= list_width)
                assert.is_truthy(line:match("^ %[.-%]"))
                local position = line:find("Working", 1, true) or line:find("Running", 1, true)
                assert.is_number(position)
                local column = vim.fn.strdisplaywidth(line:sub(1, position - 1))
                if status_column then assert.are.equal(status_column, column) else status_column = column end
                if width >= 80 then assert.is_truthy(line:find("Codex", 1, true)) else assert.is_falsy(line:find("gpt-6.1-sol", 1, true)) end
            end
            local item = picker.list:get(3)
            assert.is_truthy(item.text:find("uniquetitlesuffix", 1, true))
            assert.is_truthy(item.text:find("gpt-6.1-sol", 1, true))
            assert.is_truthy(table.concat(item.preview, "\n"):find("stripelet-loading-migrations-production", 1, true))
            assert.are.equal("remote", item.remote_ref.hostId)
            picker.input:set("uniquetitlesuffix")
            picker:find({ refresh = false })
            settle(picker, 1)
            assert.are.equal("remote:agent-c", picker:current().id)
        end)
    end

    for _, reverse in ipairs({ false, true }) do
        it("keeps diagnostics below sessions with reverse=" .. tostring(reverse) .. " before and after filtering", function()
            local local_read
            local picker = open(local_controller({
                page = function(_, callback) local_read = callback end,
                read_roster = function(callback)
                    callback(nil, { state = "roster", localHostId = "local", hosts = { {
                        hostId = "unknown", hostname = "needle.example", state = "unavailable", code = "BRIDGE_EOF",
                    } } })
                end,
            }))
            picker.list.reverse = reverse
            local a, b, c = row("agent-a"), row("agent-b"), row("agent-c")
            a.display.title, b.display.title, c.display.title = "needle first", "another needle", "unrelated"
            local_read(nil, { agents = { a, b, c }, issues = {}, handlerGeneration = "handler" })
            settle(picker, 4)
            assert.are.equal("agent-a", picker:current().id)
            resize(picker, 80)
            assert.is_truthy(rendered(picker)[4]:find("[needle]", 1, true))
            picker.input:set("'needle")
            picker:find({ refresh = false })
            settle(picker, 3)
            assert.is_true(vim.wait(1000, function() return picker:current().issue == nil end))
            picker.list:update({ force = true })
            assert.is_truthy(rendered(picker)[3]:find("[needle]", 1, true))
            picker.input:set("'needle.example")
            picker:find({ refresh = false })
            settle(picker, 1)
            assert.is_table(picker:current().issue)
        end)
    end

    it("labels an unnamed reachable remote with its short hostname and keeps it attachable", function()
        local picker = open(local_controller({
            read_roster = function(callback)
                callback(nil, { state = "roster", localHostId = "local", hosts = { {
                    hostId = "unknown", hostname = "unmatched.example", state = "available",
                    value = { agents = { row("agent-c") }, issues = {}, handlerGeneration = "handler" },
                } } })
            end,
        }))
        settle(picker, 3)
        assert.is_falsy(table.concat(rendered(picker), "\n"):find("unmatched.example", 1, true))
        assert.is_truthy(table.concat(rendered(picker), "\n"):find("[unmatched]", 1, true))
        local item = picker.list:get(3)
        assert.is_truthy(table.concat(item.preview, "\n"):find("Host: unmatched.example", 1, true))
        assert.are.equal("unknown", item.remote_ref.hostId)
    end)

    it("preserves the current-conversation picker display", function()
        local current = require("sodium.agency.picker").current({ row("agent-a") }, function() end)
        pickers[#pickers + 1] = current
        settle(current, 1)
        assert.are.equal("text", current.opts.format)
        assert.is_truthy(current:current().text:find("agent-a · Codex", 1, true))
    end)

    it("adds labeled remotes after showing locals", function()
        local owner_read
        local picker = open(local_controller({
            read_roster = function(callback) owner_read = callback end,
        }))
        settle(picker, 2)
        owner_read(nil, { state = "roster", localHostId = "local", hosts = { {
            hostId = "remote", hostname = "qa-worker.example", name = "climate", state = "available",
            value = { agents = { row("agent-c") }, issues = {}, handlerGeneration = "handler" },
        } } })
        settle(picker, 3)
        assert.is_truthy(picker.list:get(3).text:find("climate", 1, true))
    end)

    local function delayed_roster(remote)
        return { state = "roster", localHostId = "local", hosts = {
            { hostId = "remote", hostname = "qa-worker.example", name = "climate", state = "available",
                value = { agents = { remote or row("agent-c") }, issues = {}, handlerGeneration = "handler" } },
            { hostId = "offline", hostname = "unmatched.example", state = "unavailable", code = "BRIDGE_EOF" },
        } }
    end

    for _, order in ipairs({ "local,owners", "owners,local" }) do
        it("shows locals promptly and reads each source once with " .. order, function()
            local callbacks, calls, arrived = {}, {}, {}
            local picker = open({
                page = function(_, callback) callbacks.local_read = callback; calls.local_read = (calls.local_read or 0) + 1 end,
                read_roster = function(callback) callbacks.owners = callback; calls.owners = (calls.owners or 0) + 1 end,
            })
            for _, name in ipairs(vim.split(order, ",")) do
                arrived[name] = true
                if name == "local" then
                    callbacks.local_read(nil, { agents = { row("agent-a"), row("agent-b") }, issues = {}, handlerGeneration = "handler" })
                else callbacks.owners(nil, delayed_roster()) end
                if arrived["local"] then settle(picker, arrived.owners and 4 or 2)
                else assert.are.equal(0, picker:count()) end
            end
            assert.are.same({ local_read = 1, owners = 1 }, calls)
            assert.are.equal("climate", picker.list:get(3).label)
            assert.are.equal("remote", picker.list:get(3).remote_ref.hostId)
        end)
    end

    it("attaches a local row while remote reads are pending and ignores results after close", function()
        local owner_read, attached = nil, {}
        local picker = open(local_controller({
            read_roster = function(callback) owner_read = callback end,
            attach = function(id, _, selected) attached[#attached + 1] = { id = id, row = selected } end,
        }))
        settle(picker, 2)
        picker.list:view(2)
        picker.opts.confirm(picker, picker:current())
        assert.is_true(vim.wait(1000, function() return #attached == 1 end))
        owner_read(nil, delayed_roster())
        assert.are.equal(2, #picker.opts.items)
        assert.are.equal("agent-b", attached[1].id)
        assert.are.same(row("agent-b"), attached[1].row)
    end)

    for _, reverse in ipairs({ false, true }) do
        for _, pattern in ipairs({ "", "'needle" }) do
            it("preserves selection and input during delayed hydration reverse=" .. tostring(reverse) .. " pattern=" .. pattern, function()
                local local_read, owner_read, stopped = nil, nil, {}
                local a, b, remote = row("agent-a"), row("agent-b"), row("agent-c")
                a.display.title, b.display.title, remote.display.title = "needle first", "another needle", "needle"
                local picker = open(local_controller({
                    page = function(_, callback) local_read = callback end,
                    read_roster = function(callback) owner_read = callback end,
                    stop = function(selected) stopped[#stopped + 1] = selected end,
                }))
                picker.list.reverse = reverse
                local_read(nil, { agents = { a, b }, issues = {}, handlerGeneration = "handler" })
                settle(picker, 2)
                picker.input:set(pattern)
                picker:find({ refresh = false })
                settle(picker, 2)
                for index = 1, picker.list:count() do
                    if picker.list:get(index).id == "agent-b" then picker.list:view(index) end
                end
                assert.are.equal("agent-b", picker:current().id)
                owner_read(nil, delayed_roster(remote))
                settle(picker, pattern == "" and 4 or 3)
                assert.is_true(vim.wait(1000, function() return picker:current().id == "agent-b" end))
                assert.are.equal(pattern, picker.input.filter.pattern)
                stop_mapping(picker, "input", "n")()
                assert.is_true(vim.wait(1000, function() return #stopped == 1 end))
                assert.are.same(b, stopped[1])
            end)
        end
    end

    for _, action in ipairs({ "attach", "stop" }) do
        it("gates immediate " .. action .. " until the selected identity is restored", function()
            local owner_read, calls = nil, {}
            local picker = open(local_controller({
                read_roster = function(callback) owner_read = callback end,
                attach = function(id, _, selected) calls[#calls + 1] = selected end,
                stop = function(selected) calls[#calls + 1] = selected end,
            }))
            settle(picker, 2)
            picker.list:view(2)
            local invoke = action == "attach" and function() picker.opts.confirm(picker, picker:current()) end
                or stop_mapping(picker, "input", "n")
            owner_read(nil, delayed_roster())
            invoke()
            assert.is_false(picker.closed == true)
            assert.are.equal(0, #calls)
            settle(picker, 4)
            assert.is_true(vim.wait(1000, function() return picker:current().id == "agent-b" end))
            invoke()
            assert.is_true(vim.wait(1000, function() return #calls == 1 end))
            assert.are.same(row("agent-b"), calls[1])
        end)
    end

    it("honors a new filter while hydration completion is scheduled", function()
        local owner_read
        local picker = open(local_controller({ read_roster = function(callback) owner_read = callback end }))
        settle(picker, 2)
        picker.list:view(2)
        owner_read(nil, delayed_roster())
        picker.input:set("'agent-c")
        picker:find({ refresh = false })
        settle(picker, 1)
        assert.are.equal("'agent-c", picker.input.filter.pattern)
        assert.are.equal("remote:agent-c", picker:current().id)
    end)

    for _, failed in ipairs({ false, true }) do
        it("adds owner fallback after an " .. (failed and "failed" or "empty") .. " local read", function()
            local owner_read
            local picker = open(local_controller({
                page = function(_, callback)
                    if failed then callback({ code = "UNAVAILABLE", message = "Local unavailable" })
                    else callback(nil, { agents = {}, issues = {}, handlerGeneration = "handler" }) end
                end,
                read_roster = function(callback) owner_read = callback end,
            }))
            settle(picker, failed and 1 or 0)
            owner_read(nil, { state = "roster", localHostId = "local", hosts = { {
                hostId = "local", hostname = "laptop", state = "available",
                value = { agents = { row("agent-a") }, issues = {}, handlerGeneration = "handler" },
            } } })
            settle(picker, failed and 2 or 1)
            assert.are.equal("local:agent-a", picker.list:get(1).id)
        end)
    end

    it("keeps the selected agent when time advances and gets fresh data on reopening", function()
        local rows = { row("agent-a"), row("agent-b"), row("agent-c") }
        local controller = {
            page = function(_, callback)
                callback(nil, { agents = rows, issues = {}, handlerGeneration = "handler" })
            end,
        }
        local picker = open(controller)
        settle(picker, 3)
        picker.list:view(3)
        assert.are.equal("agent-c", picker:current().id)
        rows = { row("agent-d") }
        assert.is_false(vim.wait(5200, function()
            return picker:current() and picker:current().id ~= "agent-c"
        end))
        assert.are.equal("agent-c", picker:current().id)
        assert.are.equal(3, picker:count())
        picker:close()
        local reopened = open(controller)
        settle(reopened, 1)
        assert.are.equal("agent-d", reopened:current().id)
    end)

    it("opens before any data with a loading title and orders sessions by recent activity", function()
        local pending
        local controller = local_controller({ page = function(_, callback) pending = callback end })
        local picker = open(controller)
        assert.is_true(vim.wait(1000, function() return picker.title == "Agency active agents (loading…)" end))
        local a, b, c = row("agent-a"), row("agent-b"), row("agent-c")
        a.record.lastActivityAt, b.record.lastActivityAt = "2026-11-12T00:00:00Z", "2026-11-13T00:00:00Z"
        pending(nil, { agents = { a, b, c }, issues = {}, handlerGeneration = "handler" })
        settle(picker, 3)
        assert.are.equal("Agency active agents", picker.title)
        assert.are.same({ "agent-b", "agent-a", "agent-c" }, { picker.list:get(1).id, picker.list:get(2).id, picker.list:get(3).id })
    end)

    it("previews the conversation through the controller and ignores replies after close", function()
        local requests = {}
        local picker = open(local_controller({ excerpt = function(excerpt, callback) requests[#requests + 1] = { excerpt = excerpt, callback = callback } end }))
        settle(picker, 2)
        assert.is_true(vim.wait(1000, function() return #requests >= 1 end))
        assert.is_nil(requests[1].excerpt.hostId)
        requests[1].callback(nil, { state = "excerpt", source = "live", turns = { { role = "agent", text = "hi there" } }, reason = vim.NIL })
        assert.is_true(vim.wait(1000, function()
            return table.concat(vim.api.nvim_buf_get_lines(picker.preview.win.buf, 0, -1, false), "\n"):find("‹ agent: hi there", 1, true) ~= nil
        end))
        picker:close()
        local late_callback
        local late = open(local_controller({ page = function(_, callback) late_callback = callback end }))
        local title = late.title
        late:close()
        late_callback(nil, { agents = { row("agent-z") }, issues = {}, handlerGeneration = "handler" })
        vim.wait(50, function() return false end)
        assert.are.equal(title, late.title)
        assert.are.equal(0, late.list:count())
    end)

    it("redraws an excerpt that arrives after the roster refreshed the rows", function()
        local requests, roster = {}, nil
        local picker = open(local_controller({
            excerpt = function(excerpt, callback) requests[#requests + 1] = { excerpt = excerpt, callback = callback } end,
            read_roster = function(callback) roster = callback end,
        }))
        settle(picker, 2)
        assert.is_true(vim.wait(1000, function() return #requests == 1 end))
        roster(nil, { state = "roster", localHostId = "local", hosts = {} })
        settle(picker, 2)
        requests[1].callback(nil, { state = "excerpt", source = "live", turns = { { role = "agent", text = "after refresh" } }, reason = vim.NIL })
        assert.is_true(vim.wait(1000, function()
            return table.concat(vim.api.nvim_buf_get_lines(picker.preview.win.buf, 0, -1, false), "\n"):find("‹ agent: after refresh", 1, true) ~= nil
        end))
        assert.are.equal(1, #requests)
    end)
end)