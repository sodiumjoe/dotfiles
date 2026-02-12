return {
    "carlos-algms/agentic.nvim",
    cond = function()
        local claude_path = vim.fn.resolve(vim.fn.exepath("claude"))
        return vim.fn.executable(claude_path) == 1 or vim.fn.executable("gemini") == 1
    end,
    config = function()
        local utils = require("sodium.utils")
        local diagnostics = require("sodium.config.diagnostics")
        local claude_path = vim.fn.resolve(vim.fn.exepath("claude"))

        local agentic_modified_files = {}
        local agentic_tracking_augroup = vim.api.nvim_create_augroup("AgenticFileTracking", { clear = true })

        local function start_tracking_agentic_writes()
            vim.api.nvim_create_autocmd("BufWritePost", {
                group = agentic_tracking_augroup,
                callback = function(args)
                    local filepath = vim.api.nvim_buf_get_name(args.buf)
                    if filepath ~= "" and not utils.is_fugitive_buffer(args.buf) then
                        agentic_modified_files[filepath] = true
                    end
                end,
            })
        end

        local function stop_tracking_agentic_writes()
            vim.api.nvim_clear_autocmds({ group = agentic_tracking_augroup })
        end

        local function format_modified_files()
            for filepath, _ in pairs(agentic_modified_files) do
                local bufnr = vim.fn.bufnr(filepath)
                if bufnr ~= -1 and vim.api.nvim_buf_is_loaded(bufnr) then
                    vim.lsp.buf.format({ bufnr = bufnr, timeout_ms = 30000 })
                end
            end
            agentic_modified_files = {}
        end

        local function noop()
            return ""
        end

        require("agentic").setup({
            image_paste = {
                enabled = false,
            },
            file_picker = {
                enabled = false,
            },
            debug = true,
            provider = vim.fn.executable("claude") == 1 and "claude-acp" or "gemini-acp",
            acp_providers = {
                ["claude-acp"] = {
                    env = {
                        NODE_NO_WARNINGS = "1",
                        IS_AI_TERMINAL = "1",
                        NODENV_VERSION = "24.13.0",
                        CLAUDE_CODE_EXECUTABLE = claude_path,
                    },
                    default_mode = "plan",
                },
                ["gemini-acp"] = {
                    command = "gemini",
                    args = { "--experimental-acp" },
                    env = {},
                },
            },
            windows = {
                position = "bottom",
                code = diagnostics.window_opts,
                files = diagnostics.window_opts,
                input = diagnostics.window_opts,
                todos = diagnostics.window_opts,
                chat = diagnostics.window_opts,
            },
            headers = {
                chat = noop,
                input = noop,
                code = noop,
                files = noop,
                todos = noop,
            },
            hooks = {
                on_prompt_submit = function()
                    start_tracking_agentic_writes()
                end,
                on_response_complete = function()
                    vim.schedule(function()
                        stop_tracking_agentic_writes()
                        format_modified_files()
                    end)
                end,
            },
        })
    end,
    keys = {
        {
            "<leader>ac",
            function()
                require("agentic").toggle()
            end,
            mode = { "n" },
            desc = "Toggle Agentic Chat",
        },
        {
            "<leader>aa",
            function()
                require("agentic").add_selection_or_file_to_context()
            end,
            mode = { "n", "v" },
            desc = "Add file or selection to Agentic to Context",
        },
        {
            "<leader>ao",
            function()
                require("agentic").open()
            end,
            mode = { "n" },
            desc = "Open Agentic Chat",
        },
        {
            "<leader>an",
            function()
                require("agentic").new_session()
            end,
            mode = { "n" },
            desc = "New Agentic Chat session",
        },
        {
            "<leader>ar",
            function()
                require("agentic").restore_session()
            end,
            mode = { "n" },
            desc = "Restore Agentic Chat session",
        },
    },
}
