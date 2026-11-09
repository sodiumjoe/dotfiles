require("snacks").setup({ picker = { enabled = true } })
local sessions = require("sodium.agentic_sessions")

describe("Saved conversation picker", function()
    local columns, lines, provider, notify, select_ui, notifications

    before_each(function()
        columns, lines = vim.o.columns, vim.o.lines
        vim.o.columns, vim.o.lines = 180, 50
        local config = require("agentic.config")
        provider = config.acp_providers.agency
        config.acp_providers.agency = { name = "Agency", command = "fixture", args = {} }
        notify, select_ui, notifications = vim.notify, vim.ui.select, {}
        vim.notify = function(message) notifications[#notifications + 1] = message end
    end)
    after_each(function()
        for _, picker in ipairs(Snacks.picker.get()) do picker:close() end
        vim.wait(50, function() return false end)
        vim.o.columns, vim.o.lines = columns, lines
        vim.wait(30, function() return false end)
        require("agentic.config").acp_providers.agency = provider
        vim.notify, vim.ui.select = notify, select_ui
    end)

    local function open(known, native, native_error, options)
        options = options or {}
        local requests = {}
        local agent = { provider_config = require("agentic.config").acp_providers.agency }
        function agent:when_ready(callback) callback() end
        function agent:_send_request(method, params, callback)
            requests[#requests + 1] = { method = method, params = params }
            if method == "session/list" then
                if params.cursor then
                    assert.are.equal("next", params.cursor)
                    callback({ sessions = options.next_page })
                else callback({ sessions = known, nextCursor = options.next_page and "next" or nil }) end
            elseif method == "agency/backends" then callback({ backends = { { id = "codex-acp" } } })
            elseif method == "agency/native_sessions" then
                callback(native and { sessions = options.forbid_handler_native and {} or native }, native_error)
            else error("Unexpected request: " .. method) end
        end
        local client = { command = function(argv, _, callback)
            requests[#requests + 1] = { method = argv[1] }
            assert.are.same({ "native-sessions" }, argv)
            callback(options.offline_error or native_error, native and { result = { sessions = native } })
        end }
        sessions.show_picker({ agent = agent }, { lifecycle = options.lifecycle or {}, client = client })
        local picker
        assert.is_true(vim.wait(1000, function()
            if options.empty then return #notifications > 0 and #Snacks.picker.get() == 0 end
            for _, candidate in ipairs(Snacks.picker.get()) do
                if candidate.opts.title == "Select session to restore" then
                    picker = candidate
                    return not picker:is_active() and picker:count() > 0
                end
            end
        end))
        return picker, requests
    end

    it("shows a readable row and a visible preview with directory and both identities", function()
        local title = "Review the restore picker " .. string.rep("details ", 15) .. "end"
        local picker = open({ { sessionId = "agency:logical-one", cwd = "/tmp/project", title = title,
            _meta = { agency = { backendId = "codex-acp", phase = "stopped", nativeSessionId = "native-one" } } } }, {})
        assert.is_false(picker.layout:is_hidden("preview"))
        assert.is_true(vim.wo[picker.preview.win.win].wrap)
        local item = picker:current()
        local rendered = {}
        for _, chunk in ipairs(picker.opts.format(item)) do rendered[#rendered + 1] = chunk[1] end
        rendered = table.concat(rendered)
        assert.is_truthy(rendered:find("Review the restore picker", 1, true))
        assert.is_truthy(rendered:find("project", 1, true))
        assert.is_true(#rendered < #title)
        assert.is_true(vim.wait(1000, function()
            local preview = table.concat(vim.api.nvim_buf_get_lines(picker.preview.win.buf, 0, -1, false), "\n")
            return preview:find(title, 1, true) ~= nil and preview:find("/tmp/project", 1, true) ~= nil
                and preview:find("agency:logical-one", 1, true) ~= nil and preview:find("native-one", 1, true) ~= nil
        end))
    end)

    it("enriches logical rows with native titles and dates without changing restore identity", function()
        local picker = open({
            { sessionId = "agency:logical-one", title = "New conversation", cwd = "/tmp/project",
                _meta = { agency = { backendId = "codex-acp", phase = "stopped", nativeSessionId = "native-one" } } },
            { sessionId = "agency:logical-two", title = "Deliberate title", cwd = "/tmp/other", updatedAt = "2026-11-05T10:00:00Z",
                _meta = { agency = { backendId = "codex-acp", phase = "stopped", nativeSessionId = "native-two" } } },
        }, {
            { nativeSessionId = "native-one", backendId = "codex-acp", cwd = "/tmp/project", title = "Fix the picker", updatedAt = "2026-11-06T12:00:00Z" },
            { nativeSessionId = "native-two", backendId = "codex-acp", cwd = "/tmp/other", title = "Fallback title", updatedAt = "2026-11-06T11:00:00Z" },
            { nativeSessionId = "native-three", backendId = "codex-acp", cwd = "/tmp/third", title = "Older request", updatedAt = "2026-11-04T12:00:00Z" },
        })
        assert.are.equal(2, picker:count())
        local item = picker.list:get(1)
        assert.are.equal("Fix the picker", item.title)
        assert.are.equal("2026-11-06 12:00", item.updated_at)
        assert.are.equal("agency:logical-one", item.session_id)
        assert.is_nil(item.native_session_id)
        assert.are.equal("stopped", item.phase)
        assert.are.equal("Deliberate title", picker.list:get(2).title)
    end)

    it("keeps backend availability and known sessions when native discovery fails", function()
        local picker = open({ { sessionId = "agency:logical-one", title = "Saved request", cwd = "/tmp/project",
            _meta = { agency = { backendId = "claude-agent-acp", phase = "stopped", nativeSessionId = "native-one" } } } }, nil, { message = "unavailable" })
        assert.are.equal(1, picker:count())
        assert.is_true(picker:current().unavailable)
    end)

    it("reads native titles directly while Handler still serves old untitled metadata", function()
        local picker, requests = open({ { sessionId = "agency:logical-one", title = "New conversation", cwd = "/tmp/project",
            _meta = { agency = { backendId = "codex-acp", phase = "stopped", nativeSessionId = "native-one" } } } },
            { { nativeSessionId = "native-one", backendId = "codex-acp", title = "Fix the missing work sync", updatedAt = "2026-11-06T12:00:00Z" } },
            nil, { forbid_handler_native = true })
        assert.are.equal("Fix the missing work sync", picker:current().title)
        assert.are.equal("native-sessions", requests[3].method)
    end)

    it("falls back to Handler discovery when the direct reader is unavailable", function()
        local picker, requests = open({ { sessionId = "agency:logical-one", title = "New conversation", cwd = "/tmp/project",
            _meta = { agency = { backendId = "codex-acp", phase = "stopped", nativeSessionId = "native-one" } } } },
            { { nativeSessionId = "native-one", backendId = "codex-acp", title = "Retained native title" } }, nil,
            { offline_error = { code = "UNAVAILABLE" } })
        assert.are.equal("Retained native title", picker:current().title)
        assert.are.equal("agency/native_sessions", requests[4].method)
    end)

    it("lists only stopped and recoverable logical Agency sessions", function()
        local known = {}
        for _, phase in ipairs({ "stopped", "recoverable", "ready", "starting", "restoring", "stopping", "failed", "interrupted" }) do
            known[#known + 1] = { sessionId = "agency:" .. phase, cwd = "/tmp/project", title = phase,
                _meta = { agency = { backendId = "codex-acp", phase = phase, nativeSessionId = "native-" .. phase } } }
        end
        known[#known + 1] = { sessionId = "external", cwd = "/tmp/project", title = "external",
            _meta = { agency = { backendId = "codex-acp", phase = "stopped" } } }
        local picker = open(known, { { nativeSessionId = "unregistered", backendId = "codex-acp", cwd = "/tmp/other", title = "unregistered" } })
        assert.are.equal(2, picker:count())
        assert.are.equal("agency:stopped", picker.list:get(1).session_id)
        assert.are.equal("agency:recoverable", picker.list:get(2).session_id)
    end)

    it("finds closed sessions on later pages after an entirely active first page", function()
        local picker, requests = open({ { sessionId = "agency:active", cwd = "/tmp", title = "active",
            _meta = { agency = { backendId = "codex-acp", phase = "ready" } } } }, {}, nil,
            { next_page = { { sessionId = "agency:closed", cwd = "/tmp", title = "closed",
                _meta = { agency = { backendId = "codex-acp", phase = "stopped" } } } } })
        assert.are.equal(1, picker:count())
        assert.are.equal("agency:closed", picker:current().session_id)
        assert.are.equal("session/list", requests[2].method)
        assert.are.equal("next", requests[2].params.cursor)
    end)

    it("reports no closed Agency sessions without scanning or importing native history", function()
        local picker, requests = open({ { sessionId = "agency:active", cwd = "/tmp", title = "active",
            _meta = { agency = { backendId = "codex-acp", phase = "ready" } } } },
            { { nativeSessionId = "external", backendId = "codex-acp", cwd = "/tmp", title = "external" } }, nil, { empty = true })
        assert.is_nil(picker)
        assert.are.equal(1, #requests)
        assert.are.equal("session/list", requests[1].method)
        assert.is_truthy(notifications[1]:find("Agency", 1, true))
    end)

    it("restores the selected logical ID after confirmation without attaching or importing", function()
        local restored
        vim.ui.select = function(_, _, callback) callback("Restore") end
        local picker, requests = open({ { sessionId = "agency:closed", cwd = "/tmp", title = "closed",
            _meta = { agency = { backendId = "codex-acp", phase = "recoverable", nativeSessionId = "native-closed" } } } }, {}, nil,
            { lifecycle = { restore = function(id) restored = id end, attach = function() error("Unexpected attach") end } })
        picker.opts.confirm(picker, picker:current())
        assert.is_true(vim.wait(1000, function() return restored ~= nil end))
        assert.are.equal("closed", restored)
        for _, request in ipairs(requests) do assert.is_not.equal("agency/import", request.method) end
    end)

    it("gives untitled sessions distinguishable searchable rows", function()
        local items = sessions.normalize_sessions({
            { nativeSessionId = "first-id", cwd = "/tmp/first", backendId = "codex-acp" },
            { nativeSessionId = "second-id", cwd = "/tmp/second", backendId = "codex-acp" },
        })
        assert.is_not.equal(items[1].text, items[2].text)
        assert.is_truthy(items[1].text:find("first", 1, true))
        assert.is_truthy(items[2].text:find("second", 1, true))
    end)
end)