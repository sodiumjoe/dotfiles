describe("sodium.statusline", function()
    local statusline

    before_each(function()
        statusline = require("sodium.statusline")
    end)

    describe("get_filename", function()
        it("returns staged prefix for fugitive buffers", function()
            local buf = vim.api.nvim_create_buf(false, true)
            vim.api.nvim_set_current_buf(buf)
            vim.api.nvim_buf_set_name(buf, "fugitive:///Users/moon/.dotfiles//abc123def/src/foo.lua")
            assert.are.equal("[staged]: src/foo.lua", statusline.get_filename())
            vim.api.nvim_buf_delete(buf, { force = true })
        end)

        it("returns relative path for normal buffers", function()
            local buf = vim.api.nvim_create_buf(false, true)
            vim.api.nvim_set_current_buf(buf)
            vim.api.nvim_buf_set_name(buf, "/tmp/test_statusline_file.lua")
            local result = statusline.get_filename()
            assert.is_truthy(result)
            assert.is_not.equal("", result)
            vim.api.nvim_buf_delete(buf, { force = true })
        end)
    end)

    describe("get_agentic_title", function()
        local original_ft

        before_each(function()
            original_ft = vim.bo.filetype
        end)

        after_each(function()
            vim.bo.filetype = original_ft
        end)

        it("returns chat title for AgenticChat", function()
            vim.bo.filetype = "AgenticChat"
            assert.are.equal("󰻞 Agentic Chat", statusline.get_agentic_title())
        end)

        it("returns prompt title for AgenticInput", function()
            vim.bo.filetype = "AgenticInput"
            assert.are.equal("󰦨 Prompt", statusline.get_agentic_title())
        end)

        it("returns code title for AgenticCode", function()
            vim.bo.filetype = "AgenticCode"
            assert.are.equal("󰪸 Selected Code Snippets", statusline.get_agentic_title())
        end)

        it("returns files title for AgenticFiles", function()
            vim.bo.filetype = "AgenticFiles"
            assert.are.equal("󰪸 Referenced Files", statusline.get_agentic_title())
        end)

        it("returns todos title for AgenticTodos", function()
            vim.bo.filetype = "AgenticTodos"
            assert.are.equal("☐ TODO Items", statusline.get_agentic_title())
        end)

        it("returns empty string for other filetypes", function()
            vim.bo.filetype = "lua"
            assert.are.equal("", statusline.get_agentic_title())
        end)
    end)

    describe("agentic session metadata", function()
        local original_ft

        local function with_agentic_session(session_manager, callback)
            package.loaded["agentic.session_registry"] = {
                get_session_for_tab_page = function(tab_page_id)
                    assert.are.equal(vim.api.nvim_get_current_tabpage(), tab_page_id)
                    return session_manager
                end,
            }

            local ok, err = pcall(callback)
            package.loaded["agentic.session_registry"] = nil

            if not ok then
                error(err)
            end
        end

        before_each(function()
            original_ft = vim.bo.filetype
            vim.bo.filetype = "AgenticChat"
        end)

        after_each(function()
            vim.bo.filetype = original_ft
            package.loaded["agentic.session_registry"] = nil
        end)

        it("returns context usage from the agentic session state", function()
            with_agentic_session({
                session_state = {
                    get_context_used = function()
                        return "10K"
                    end,
                    get_context_size = function()
                        return "200K"
                    end,
                },
            }, function()
                assert.are.equal("10K/200K", statusline.get_agentic_context())
            end)
        end)

        it("returns an empty context when either context value is missing", function()
            with_agentic_session({
                session_state = {
                    get_context_used = function()
                        return "10K"
                    end,
                    get_context_size = function()
                        return nil
                    end,
                },
            }, function()
                assert.are.equal("", statusline.get_agentic_context())
            end)
        end)

        it("returns the model name from the agentic session state", function()
            with_agentic_session({
                session_state = {
                    get_model_name = function()
                        return "gpt-5.5"
                    end,
                },
            }, function()
                assert.are.equal("gpt-5.5", statusline.get_agentic_model())
            end)
        end)

        it("returns an empty model when the session has no model name", function()
            with_agentic_session({
                session_state = {
                    get_model_name = function()
                        return nil
                    end,
                },
            }, function()
                assert.are.equal("", statusline.get_agentic_model())
            end)
        end)
    end)

    describe("agentic lualine setup", function()
        local original_ft
        local original_lualine

        local function load_with_lualine_stub()
            package.loaded["sodium.statusline"] = nil
            original_lualine = package.loaded.lualine

            local captured_config
            package.loaded.lualine = {
                setup = function(config)
                    captured_config = config
                end,
            }

            local ok, loaded = pcall(require, "sodium.statusline")
            package.loaded.lualine = original_lualine

            if not ok then
                error(loaded)
            end

            return loaded, captured_config
        end

        before_each(function()
            original_ft = vim.bo.filetype
            vim.bo.filetype = "AgenticChat"
        end)

        after_each(function()
            vim.bo.filetype = original_ft
            package.loaded["agentic.session_registry"] = nil
            package.loaded["sodium.statusline"] = nil
            package.loaded.lualine = original_lualine
            statusline = require("sodium.statusline")
        end)

        it("places model after the agentic title and keeps context in the right status sections", function()
            package.loaded["agentic.session_registry"] = {
                get_session_for_tab_page = function()
                    return {
                        is_generating = false,
                        session_state = {
                            get_context_used = function()
                                return "10K"
                            end,
                            get_context_size = function()
                                return "200K"
                            end,
                            get_model_name = function()
                                return "gpt-5.5"
                            end,
                        },
                        agent_modes = {
                            current_mode_id = "agent-full-access",
                            get_mode = function()
                                return { name = "Full Access" }
                            end,
                        },
                    }
                end,
            }

            local _, captured_config = load_with_lualine_stub()

            local extension = assert(captured_config).extensions[1]
            local rendered_left = {}
            local rendered_right = {}

            for _, component in ipairs(extension.sections.lualine_a) do
                if type(component) == "table" and type(component[1]) == "function" then
                    local value = component[1]()
                    if value ~= "│" and value ~= "" then
                        table.insert(rendered_left, value)
                    end
                elseif type(component) == "function" then
                    local value = component()
                    if value ~= "" then
                        table.insert(rendered_left, value)
                    end
                end
            end

            for _, component in ipairs(extension.sections.lualine_x) do
                if type(component) == "table" and type(component[1]) == "function" then
                    local value = component[1]()
                    if value ~= "│" and value ~= "" then
                        table.insert(rendered_right, value)
                    end
                end
            end

            assert.are.same({
                "󰻞 Agentic Chat",
                "gpt-5.5",
            }, rendered_left)
            assert.are.same({
                "10K/200K",
                require("sodium.utils").icons.ok,
                "Full Access",
            }, rendered_right)
        end)
    end)
end)
