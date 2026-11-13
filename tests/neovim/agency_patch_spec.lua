package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
dofile(vim.env.DOTFILES_TEST_ROOT .. "/home/.config/nvim/lua/sodium/plugins/agentic.lua").config()

describe("Agency patch reinstall", function()
    local f
    before_each(function() f = require("fixtures.agency_native").new() end)
    after_each(function() f.close() end)

    local function reinstall()
        for _, name in ipairs({ "sodium.agency.agentic", "sodium.agency.animation", "sodium.agency.stream", "sodium.agentic_folds" }) do
            package.loaded[name] = nil
        end
        require("sodium.agentic_folds").install()
        require("sodium.agency.agentic").install()
    end

    it("renders a streamed chunk once after two reinstalls", function()
        reinstall()
        reinstall()
        local writer, renders = f.manager.message_writer, 0
        local write = writer.write_message_chunk
        writer.write_message_chunk = function(self, update)
            renders = renders + 1
            return write(self, update)
        end
        f.client:_handle_message({ method = "session/update", params = { sessionId = f.manager.session_id,
            update = { sessionUpdate = "agent_message_chunk", content = { type = "text", text = "reinstall-marker" } } } })
        assert.is_true(vim.wait(300, function() return renders > 0 end, 1))
        vim.wait(50, function() return false end)
        local text = table.concat(vim.api.nvim_buf_get_lines(writer.bufnr, 0, -1, false), "\n")
        local _, count = text:gsub("reinstall%-marker", "")
        assert.are.equal(1, count)
        assert.are.equal(1, renders)
    end)

    it("uses the reloaded fold module after a reinstall", function()
        local Writer = require("agentic.ui.message_writer")
        local first = Writer.update_tool_call_block
        reinstall()
        assert.are_not.equal(first, Writer.update_tool_call_block)
        assert.are.equal(rawget(Writer, "__sodium_originals").update_tool_call_block, require("sodium.patch").original(Writer, "update_tool_call_block"))
    end)
end)