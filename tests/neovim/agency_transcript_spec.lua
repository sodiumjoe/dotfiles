package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
dofile(vim.env.DOTFILES_TEST_ROOT .. "/home/.config/nvim/lua/sodium/plugins/agentic.lua").config()

describe("Agency transcript", function()
    local Transcript = require("sodium.agency.transcript")
    local f, Trim, limits, notices, notify, answered
    local transcript = {
        state = "transcript",
        agentId = "a",
        truncated = true,
        reason = vim.NIL,
        turns = { { role = "user", text = "fix it" }, { role = "agent", text = "Done.\n\n- one" } },
    }
    local rendered =
        { "> Older turns were not kept.", "", "## User", "", "fix it", "", "## Agent", "", "Done.", "", "- one" }
    before_each(function()
        Trim = require("sodium.agency.trim")
        limits = { Trim.LIMIT, Trim.TARGET }
        Trim.LIMIT, Trim.TARGET = 60, 40
        answered, notices, notify = {}, {}, vim.notify
        vim.notify = function(message, level)
            notices[#notices + 1] = { message = message, level = level }
        end
        f = require("fixtures.agency_native").new()
    end)
    after_each(function()
        vim.notify = notify
        Trim.LIMIT, Trim.TARGET = unpack(limits)
        for _, buf in ipairs(vim.api.nvim_list_bufs()) do
            if vim.api.nvim_buf_get_name(buf):find("agency://transcript/", 1, true) then
                vim.api.nvim_buf_delete(buf, { force = true })
            end
        end
        f.close()
    end)
    local function reply(body)
        local frame
        assert.is_true(vim.wait(1000, function()
            local ok, found = pcall(f.request, "agency/transcript")
            frame = ok and not answered[found.id] and found or nil
            return frame ~= nil
        end))
        answered[frame.id] = true
        f.client:_handle_message(vim.tbl_extend("force", { id = frame.id }, body))
        f.flush()
        return frame
    end
    local function trimmed_chat()
        local writer = f.manager.message_writer
        for i = 1, 8 do
            writer:write_message({
                sessionUpdate = "user_message_chunk",
                content = { type = "text", text = "question " .. i },
            })
            f.client:_handle_message({
                method = "session/update",
                params = {
                    sessionId = f.manager.session_id,
                    update = {
                        sessionUpdate = "agent_message_chunk",
                        content = { type = "text", text = "answer " .. i .. ".1\nanswer " .. i .. ".2" },
                    },
                },
            })
            f.flush()
        end
        f.state("t8", "idle")
        assert.are.equal(0, Trim.marker_row(writer.bufnr))
        local chat = f.manager.widget.win_nrs.chat
        vim.api.nvim_set_current_win(chat)
        vim.api.nvim_win_set_cursor(chat, { 1, 0 })
        return chat
    end
    local function shown()
        local buf = vim.api.nvim_win_get_buf(require("sodium.agency.screen").document_window())
        return buf, vim.api.nvim_buf_get_name(buf)
    end

    it("renders turns under headings and notes truncation", function()
        assert.are.same(rendered, Transcript.lines(transcript))
    end)

    it("says there is nothing to show for a transcript with no turns", function()
        assert.are.same(
            { "No conversation text yet." },
            Transcript.lines({ state = "transcript", agentId = "a", turns = {}, truncated = false, reason = vim.NIL })
        )
    end)

    it("opens a read-only markdown buffer in the document window from the marker's <CR>", function()
        local chat = trimmed_chat()
        vim.fn.maparg("<CR>", "n", false, true).callback()
        local frame = reply({ result = transcript })
        assert.are.same({ agentId = f.row.record.definition.agentId }, frame.params)
        assert.is_true(vim.wait(1000, function()
            return require("sodium.agency.screen").document_window() ~= nil
        end))
        local buf, name = shown()
        assert.are_not.equal(chat, vim.fn.bufwinid(buf))
        assert.are.equal("agency://transcript/" .. f.row.record.definition.agentId, name)
        assert.are.equal("markdown", vim.bo[buf].filetype)
        assert.are.equal("nofile", vim.bo[buf].buftype)
        assert.is_false(vim.bo[buf].modifiable)
        assert.are.same(rendered, vim.api.nvim_buf_get_lines(buf, 0, -1, false))
    end)

    it("does not open the transcript from <CR> below the marker", function()
        local chat = trimmed_chat()
        vim.api.nvim_win_set_cursor(chat, { 3, 0 })
        vim.fn.maparg("<CR>", "n", false, true).callback()
        f.flush()
        vim.wait(50)
        assert.is_false(pcall(f.request, "agency/transcript"))
    end)

    it("replaces the buffer of an existing document window", function()
        trimmed_chat()
        local screen = require("sodium.agency.screen")
        local win = screen.ensure_document()
        local before = vim.api.nvim_win_get_buf(win)
        Transcript.open(f.manager)
        reply({ result = transcript })
        assert.is_true(vim.wait(1000, function()
            return vim.api.nvim_win_get_buf(win) ~= before
        end))
        assert.are.equal(win, screen.document_window())
        assert.are.same(rendered, vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(win), 0, -1, false))
        Transcript.open(f.manager)
        reply({
            result = vim.tbl_extend(
                "force",
                transcript,
                { truncated = false, turns = { { role = "user", text = "again" } } }
            ),
        })
        assert.is_true(vim.wait(1000, function()
            return vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(win), 0, -1, false)[1] == "## User"
        end))
        assert.are.same(
            { "## User", "", "again" },
            vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(win), 0, -1, false)
        )
    end)

    it("reports when no Agency session is in the tab", function()
        for _, key in ipairs(vim.tbl_keys(require("agentic.session_registry").sessions)) do
            require("agentic.session_registry").destroy(key)
        end
        Transcript.open()
        assert.are.equal(1, #notices)
        assert.is_truthy(notices[1].message:find("No Agency session", 1, true))
        assert.is_false(pcall(f.request, "agency/transcript"))
    end)

    it("reports when the Handler does not serve agency/transcript", function()
        Transcript.open(f.manager)
        reply({ error = { code = -32601, message = "Method not found" } })
        assert.is_true(vim.wait(1000, function()
            return #notices > 0
        end))
        assert.is_truthy(notices[1].message:find(":AgencyReload", 1, true))
        assert.are.equal(vim.log.levels.ERROR, notices[1].level)
    end)

    it("opens the transcript from :AgencyTranscript", function()
        vim.cmd("AgencyTranscript")
        reply({ result = transcript })
        assert.is_true(vim.wait(1000, function()
            return require("sodium.agency.screen").document_window() ~= nil
        end))
        assert.are.same(rendered, vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(require("sodium.agency.screen").document_window()), 0, -1, false))
    end)
end)