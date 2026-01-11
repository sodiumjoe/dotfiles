-- disable netrw so dirvish will work on startup
vim.g.loaded_netrw = 1
vim.g.loaded_netrwPlugin = 1

-- Bootstrap lazy.nvim
local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not vim.uv.fs_stat(lazypath) then
    local lazyrepo = "https://github.com/folke/lazy.nvim.git"
    local out = vim.fn.system({ "git", "clone", "--filter=blob:none", "--branch=stable", lazyrepo, lazypath })
    if vim.v.shell_error ~= 0 then
        vim.api.nvim_echo({
            { "Failed to clone lazy.nvim:\n", "ErrorMsg" },
            { out,                            "WarningMsg" },
            { "\nPress any key to exit..." },
        }, true, {})
        vim.fn.getchar()
        os.exit(1)
    end
end
vim.opt.rtp:prepend(lazypath)

local utils = require("sodium.utils")

local autoformat_augroup = vim.api.nvim_create_augroup("LspFormatting", { clear = true })

local function is_fugitive_buffer(bufnr)
    return vim.api.nvim_buf_get_name(bufnr):match("^fugitive://") ~= nil
end

local function setup_format_on_save(client, bufnr)
    if not client:supports_method("textDocument/formatting") or is_fugitive_buffer(bufnr) then
        return
    end

    vim.api.nvim_clear_autocmds({ group = autoformat_augroup, buffer = bufnr })
    vim.api.nvim_create_autocmd("BufWritePre", {
        group = autoformat_augroup,
        buffer = bufnr,
        callback = function()
            vim.lsp.buf.format({ timeout_ms = 30000 })
        end,
    })
end

local function noop() return "" end

local claude_path = vim.fn.exepath("claude")

local window_opts = {
    win_opts = {
        foldcolumn = "1",
    },
}

local diagnostic_config = {
    signs = {
        text = {
            [vim.diagnostic.severity.ERROR] = utils.icons.Error,
            [vim.diagnostic.severity.WARN] = utils.icons.Warn,
            [vim.diagnostic.severity.INFO] = utils.icons.Info,
            [vim.diagnostic.severity.HINT] = utils.icons.Hint,
        },
        numhl = {
            [vim.diagnostic.severity.ERROR] = "",
            [vim.diagnostic.severity.WARN] = "",
            [vim.diagnostic.severity.HINT] = "",
            [vim.diagnostic.severity.INFO] = "",
        },
    },
    severity_sort = true,
    virtual_text = false,
    virtual_lines = {
        format = utils.virtual_lines_format,
    },
    update_in_insert = false,
    float = {
        focusable = false,
        format = function(diagnostic)
            local str = string.format("[%s] %s", diagnostic.source, diagnostic.message)
            if diagnostic.code then
                str = str .. " (" .. diagnostic.code .. ")"
            end
            return str
        end,
    },
}

require("lazy").setup({
    {
        "rktjmp/shipwright.nvim",
        cmd = { "Shipwright" },
        lazy = true,
    },
    {
        "rktjmp/lush.nvim",
        lazy = true,
    },
    {
        "benizi/vim-automkdir",
        event = "BufWritePre",
    },
    {
        "catgoose/nvim-colorizer.lua",
        opts = {},
        lazy = true,
    },
    {
        "sodiumjoe/agentic.nvim",
        opts = {
            provider = "claude-acp",
            acp_providers = {
                ["claude-acp"] = {
                    env = {
                        NODE_NO_WARNINGS = "1",
                        IS_AI_TERMINAL = "1",
                        NODENV_VERSION = "24.9.0",
                        CLAUDE_CODE_EXECUTABLE = claude_path,
                    },
                },
            },
            windows = {
                code = window_opts,
                files = window_opts,
                input = window_opts,
                todos = window_opts,
                chat = window_opts,
            },
            headers = {
                chat = noop,
                input = noop,
                code = noop,
                files = noop,
                todos = noop,
            },
        },
        keys = {
            {
                "<leader>ac",
                function() require("agentic").toggle() end,
                mode = { "n" },
                desc = "Toggle Agentic Chat",
            },
            {
                "<leader>aa",
                function() require("agentic").add_selection_or_file_to_context() end,
                mode = { "n", "v" },
                desc = "Add file or selection to Agentic to Context",
            },
            {
                "<leader>ao",
                function() require("agentic").open() end,
                mode = { "n" },
                desc = "Open Agentic Chat",
            },
            {
                "<leader>an",
                function() require("agentic").new_session() end,
                mode = { "n" },
                desc = "New Agentic Chat session",
            },

        },
    },
    {
        "davidosomething/format-ts-errors.nvim",
        opts = {
            add_markdown = true,    -- wrap output with markdown ```ts ``` markers
            start_indent_level = 0, -- initial indent
        },
        lazy = true,
    },
    {
        "echasnovski/mini.nvim",
        version = "*",
        lazy = true,
    },
    {
        "echasnovski/mini.move",
        version = "*",
        opts = {
            -- Module mappings. Use `''` (empty string) to disable one.
            mappings = {
                -- Move visual selection in Visual mode. Defaults are Alt (Meta) + hjkl.
                left = "",
                right = "",
                down = "<C-j>",
                up = "<C-k>",

                -- Move current line in Normal mode
                line_left = "",
                line_right = "",
                line_down = "<C-j>",
                line_up = "<C-k>",
            },
        },
        keys = { "<C-j>", "<C-k>", "v", "V", "<C-v>" },
        lazy = true,
    },
    {
        "folke/lazydev.nvim",
        ft = "lua", -- only load on lua files
        opts = {
            library = {
                { path = "${3rd}/luv/library", words = { "vim%.uv" } },
                { path = "snacks.nvim",        words = { "Snacks" } },
                { path = "lazy.nvim",          words = { "LazyVim" } },
            },
        },
        lazy = true,
    },
    {
        "folke/snacks.nvim",
        priority = 1000,
        lazy = false,
        opts = {
            picker = {
                main = {
                    file = false,
                    current = true,
                },
                prompt = "❯ ",
                reverse = true,
                layout = {
                    reverse = true,
                    layout = {
                        box = "horizontal",
                        backdrop = false,
                        width = 0.9,
                        height = 0.9,
                        border = "none",
                        {
                            box = "vertical",
                            { win = "list",  title = " Results ", title_pos = "center", border = "rounded" },
                            { win = "input", height = 1,          border = "rounded",   title = "{title} {live} {flags}", title_pos = "center" },
                        },
                        {
                            win = "preview",
                            title = "{preview:Preview}",
                            width = 0.5,
                            border = "rounded",
                            title_pos = "center",
                        },
                    },
                },
                previewers = {
                    diff = {
                        style = "syntax",
                    },
                },
            },
            quickfile = { enabled = true },
            scroll = { enabled = true },
        },
        keys = {
            { "<leader>sb",       function() Snacks.picker.buffers({ on_show = function() vim.cmd.stopinsert() end, current = false }) end, desc = "Buffers" },
            { "<leader>/",        function() Snacks.picker.grep({ hidden = true }) end,                                                     desc = "Grep" },
            { "<leader><Space>/", function() Snacks.picker.grep({ dirs = { vim.fn.expand("%:h") }, hidden = true }) end,                    desc = "Grep cwd" },
            { "<leader>:",        function() Snacks.picker.command_history({ on_show = function() vim.cmd.stopinsert() end }) end,          desc = "Command History" },
            { "<C-p>",            function() Snacks.picker.files({ hidden = true }) end,                                                    desc = "Find Files" },
            {
                "<leader>8",
                function()
                    Snacks.picker.grep_word({
                        hidden = true,
                        on_show = function()
                            vim.cmd
                                .stopinsert()
                        end,
                    })
                end,
                desc = "Find Files",
            },
            -- find
            { "<leader>g",  function() Snacks.picker.git_status({ on_show = function() vim.cmd.stopinsert() end }) end,  desc = "Git Status" },
            -- Grep
            { '<leader>s"', function() Snacks.picker.registers() end,                                                    desc = "Registers" },
            { "<leader>sa", function() Snacks.picker.autocmds() end,                                                     desc = "Autocmds" },
            { "<leader>sc", function() Snacks.picker.command_history() end,                                              desc = "Command History" },
            { "<leader>sC", function() Snacks.picker.commands() end,                                                     desc = "Commands" },
            { "<leader>sd", function() Snacks.picker.diagnostics({ on_show = function() vim.cmd.stopinsert() end }) end, desc = "Diagnostics" },
            { "<leader>sh", function() Snacks.picker.help() end,                                                         desc = "Help Pages" },
            { "<leader>sH", function() Snacks.picker.highlights() end,                                                   desc = "Highlights" },
            { "<leader>sj", function() Snacks.picker.jumps() end,                                                        desc = "Jumps" },
            { "<leader>sk", function() Snacks.picker.keymaps() end,                                                      desc = "Keymaps" },
            { "<leader>sl", function() Snacks.picker.loclist() end,                                                      desc = "Location List" },
            { "<leader>sM", function() Snacks.picker.man() end,                                                          desc = "Man Pages" },
            { "<leader>sm", function() Snacks.picker.marks() end,                                                        desc = "Marks" },
            { "<leader>r",  function() Snacks.picker.resume({ on_show = function() vim.cmd.stopinsert() end }) end,      desc = "Resume" },
            { "<leader>sq", function() Snacks.picker.qflist() end,                                                       desc = "Quickfix List" },
            -- LSP
            { "gd",         function() Snacks.picker.lsp_definitions() end,                                              desc = "Goto Definition" },
            { "gr",         function() Snacks.picker.lsp_references() end,                                               nowait = true,           desc = "References" },
        },
    },
    {
        "haya14busa/is.vim",
        keys = {
            "/",
            "n",
            "N",
            "*",
            "#",
            "g*",
            "g#",
        },
    },
    {
        "justinmk/vim-dirvish",
        config = function()
            local dirvish_autocmd = utils.augroup("DirvishConfig", { clear = true })
            dirvish_autocmd("FileType", {
                pattern = { "dirvish" },
                command = "silent! unmap <buffer> <C-p>",
            })
            dirvish_autocmd("FileType", {
                pattern = { "dirvish" },
                command = "silent! unmap <buffer> <C-n>",
            })
            dirvish_autocmd("FileType", {
                pattern = "dirvish",
                callback = function()
                    vim.cmd("syntax on")
                end,
            })
        end,
    },
    {
        "kaplanz/nvim-retrail",
        opts = {
            -- Highlight group to use for trailing whitespace.
            hlgroup = "Error",
            -- Pattern to match trailing whitespace against. Edit with caution!
            pattern = "\\v((.*%#)@!|%#)\\s+$",
            -- Enabled filetypes.
            filetype = {
                -- Strictly enable only on `include`ed filetypes. When false, only disabled
                -- on an `exclude`ed filetype.
                strict = false,
                -- Included filetype list.
                include = {},
                -- Excluded filetype list. Overrides `include` list.
                exclude = {
                    "",
                    "aerial",
                    "alpha",
                    "checkhealth",
                    "diff",
                    "lazy",
                    "lspinfo",
                    "man",
                    "mason",
                    "WhichKey",
                    "markdown",
                    "javascript",
                },
            },
            -- Enabled buftypes.
            buftype = {
                -- Strictly enable only on `include`ed buftypes. When false, only disabled
                -- on an `exclude`ed buftype.
                strict = false,
                -- Included filetype list. Overrides `include` list.
                include = {},
                -- Excluded filetype list.
                exclude = {
                    "help",
                    "nofile",
                    "prompt",
                    "quickfix",
                    "terminal",
                },
            },
            -- Trim on write behaviour.
            trim = {
                -- Auto trim on BufWritePre
                auto = true,
                -- Trailing whitespace as highlighted.
                whitespace = true,
                -- Final blank (i.e. whitespace only) lines.
                blanklines = false,
            },
        },
    },
    {
        "luukvbaal/statuscol.nvim",
        config = function()
            local builtin = require("statuscol.builtin")
            require("statuscol").setup({
                segments = {
                    {
                        text = { builtin.lnumfunc },
                        sign = { namespace = { "diagnostic" } },
                    },
                    { text = { " " } },
                    {
                        sign = {
                            name = { "Signify.*" },
                            fillchar = "│",
                            colwidth = 1,
                        },
                    },
                    { text = { " " } },
                },
            })
        end,
    },
    {
        "mhinz/vim-signify",
        config = function()
            vim.g.signify_sign_add = "│"
            vim.g.signify_sign_change = "│"
            vim.g.signify_sign_change_delete = "_│"
            vim.g.signify_sign_show_count = 0
            vim.g.signify_skip = { vcs = { allow = { "git" } } }
        end,
    },
    {
        "neovim/nvim-lspconfig",
        config = function()
            local blink = require("blink.cmp")

            vim.diagnostic.config(diagnostic_config)

            local on_attach = function(client, bufnr)
                setup_format_on_save(client, bufnr)
                require("lspkind").init({})
                require("sodium.statusline").on_attach()
            end

            -- local devbox_tsserver_path = "/pay/src/pay-server/frontend/js-scripts/node_modules/typescript/lib"

            local base_capabilities = blink.get_lsp_capabilities(vim.lsp.protocol.make_client_capabilities())

            vim.lsp.config('*', {
                capabilities = base_capabilities,
            })

            vim.lsp.config('bazel', {
                cmd = { "pay", "exec", "scripts/dev/bazel-lsp" },
                filetypes = { "star", "bzl", "BUILD.bazel" },
                root_markers = { '.git' },
            })

            vim.lsp.config('rust_analyzer', {
                filetypes = { 'rust' },
                root_markers = { 'Cargo.toml' },
                settings = {
                    ["rust-analyzer"] = {
                        cargo = {
                            features = "all",
                        },
                    },
                },
            })

            vim.lsp.config('sorbet', {
                cmd = {
                    "pay",
                    "exec",
                    "scripts/bin/typecheck",
                    "--lsp",
                    "--enable-all-experimental-lsp-features",
                },
                init_options = {
                    supportsOperationNotifications = true,
                    supportsSorbetURIs = true,
                },
                settings = {},
            })

            vim.lsp.config('eslint', {
                cmd_env = { BROWSERSLIST_IGNORE_OLD_DATA = "1" },
                handlers = {
                    ["textDocument/diagnostic"] = function(_, result, ctx)
                        if result == nil or result.items == nil then return end

                        -- ignore prettier diagnostics since it autofixes anyway
                        local idx = 1
                        while idx <= #result.items do
                            local entry = result.items[idx]
                            if entry.code == "prettier/prettier" then
                                table.remove(result.items, idx)
                            else
                                idx = idx + 1
                            end
                        end

                        vim.lsp.diagnostic.on_diagnostic(
                            _,
                            result,
                            ctx
                        )
                    end,
                },
            })

            vim.lsp.config('flow', {})

            vim.lsp.config('lua_ls', {})

            local lsp_attach_group = vim.api.nvim_create_augroup("UserLspAttach", { clear = true })
            vim.api.nvim_create_autocmd("LspAttach", {
                group = lsp_attach_group,
                callback = function(args)
                    if is_fugitive_buffer(args.buf) then
                        vim.schedule(function()
                            vim.diagnostic.enable(false, { bufnr = args.buf })
                        end)
                        return
                    end

                    local client = vim.lsp.get_client_by_id(args.data.client_id)
                    if not client then return end

                    on_attach(client, args.buf)

                    if client.name == "eslint" then
                        vim.api.nvim_create_autocmd("BufWritePre", {
                            buffer = args.buf,
                            command = "LspEslintFixAll",
                        })
                    end
                end,
            })

            local lsp_servers = {
                { 'rust_analyzer', 'rust-analyzer' },
                { 'bazel',         nil },
                { 'sorbet',        nil },
                { 'eslint',        nil },
                { 'flow',          'flow' },
                { 'tsgo',          nil },
                { 'lua_ls',        'lua-language-server' },
            }

            local enabled_servers = {}
            for _, entry in ipairs(lsp_servers) do
                local server, executable = entry[1], entry[2]
                if executable == nil or vim.fn.executable(executable) == 1 then
                    table.insert(enabled_servers, server)
                end
            end

            vim.lsp.enable(enabled_servers)
        end,
        keys = {
            { "gD",           vim.lsp.buf.declaration },
            { "K",            function() vim.lsp.buf.hover({ focusable = false }) end },
            { "gi",           vim.lsp.buf.implementation },
            { [[<leader>D]],  vim.lsp.buf.type_definition },
            { [[<leader>ca]], vim.lsp.buf.code_action },
            { [[<leader>ee]], function()
                local new_config = not vim.diagnostic.config().virtual_lines
                vim.diagnostic.config({
                    virtual_lines = new_config and {
                        format = utils.virtual_lines_format,
                    } or false,
                })
            end },
            {
                [[<leader>p]],
                function()
                    vim.diagnostic.jump({
                        count = -1,
                        severity = vim.diagnostic.severity.ERROR,
                    })
                end,
            },
            {
                [[<leader>n]],
                function()
                    vim.diagnostic.jump({
                        count = 1,
                        severity = vim.diagnostic.severity.ERROR,
                    })
                end,
            },
            {
                [[<leader><Space>n]],
                function()
                    vim.diagnostic.jump({
                        count = 1,
                        severity = {
                            max = vim.diagnostic.severity.WARN,
                        },
                    })
                end,
            },
            {
                [[<leader><Space>p]],
                function()
                    vim.diagnostic.jump({
                        count = -1,
                        severity = {
                            max = vim.diagnostic.severity.WARN,
                        },
                    })
                end,
            },
            {
                [[<leader>f]],
                function()
                    vim.lsp.buf.format({ timeout_ms = 30000 })
                end,
            },
        },
        lazy = false,
    },
    {
        "nvim-lualine/lualine.nvim",
        config = function()
            require("sodium.statusline")
        end,
        lazy = false,
    },
    {
        "nvim-treesitter/nvim-treesitter",
        build = ":TSUpdate",
        main = "nvim-treesitter.configs",
        opts = {
            additional_vim_regex_highlighting = false,
            ensure_installed = {
                "bash",
                "css",
                "go",
                "html",
                "java",
                "javascript",
                "json",
                "lua",
                "markdown",
                "markdown_inline",
                "python",
                "regex",
                "ruby",
                "rust",
                "starlark",
                "tsx",
                "typescript",
                "vim",
                "yaml",
            },
            -- https://github.com/nvim-treesitter/nvim-treesitter/issues/1313
            ignore_install = { "comment", "jsdoc" },
            highlight = {
                enable = true,
                disable = {},
            },
        },
    },
    {
        "nvim-treesitter/playground",
        opts = {
            playground = {
                enable = true,
                disable = {},
                updatetime = 25,         -- Debounced time for highlighting nodes in the playground from source code
                persist_queries = false, -- Whether the query persists across vim sessions
                keybindings = {
                    toggle_query_editor = "o",
                    toggle_hl_groups = "i",
                    toggle_injected_languages = "t",
                    toggle_anonymous_nodes = "a",
                    toggle_language_display = "I",
                    focus_language = "f",
                    unfocus_language = "F",
                    update = "R",
                    goto_node = "<cr>",
                    show_help = "?",
                },
            },
        },
        cmd = { "TSPlaygroundToggle" },
        lazy = true,
    },
    "nvim-treesitter/nvim-treesitter-context",
    {
        "nvimtools/none-ls.nvim",
        config = function()
            local null_ls = require("null-ls")

            local sources = {
                null_ls.builtins.formatting.buildifier.with({
                    condition = function(util)
                        return util.root_has_file({ "scripts/dev/buildifier" })
                    end,
                    command = "scripts/dev/buildifier",
                }),
                null_ls.builtins.diagnostics.rubocop.with({
                    condition = function()
                        return utils.is_executable("scripts/bin/rubocop-daemon/rubocop")
                    end,
                    command = "scripts/bin/rubocop-daemon/rubocop",
                }),
                null_ls.builtins.formatting.prettier.with({
                    prefer_local = "node_modules/.bin",
                    condition = function(util)
                        return util.root_has_file("prettier.config.js")
                    end,
                }),
            }

            null_ls.setup({
                sources = sources,
                should_attach = function(bufnr)
                    return not is_fugitive_buffer(bufnr)
                end,
                on_attach = setup_format_on_save,
            })
        end,
    },
    {
        "nvim-lua/plenary.nvim",
        lazy = true,
    },
    {
        "onsails/lspkind-nvim",
        lazy = true,
    },
    {
        "rafamadriz/friendly-snippets",
        lazy = true,
    },
    "rhysd/conflict-marker.vim",
    {
        'saghen/blink.cmp',
        lazy = false, -- lazy loading handled internally
        -- use a release tag to download pre-built binaries
        version = 'v1.*',

        ---@module 'blink.cmp'
        ---@type blink.cmp.Config
        opts = {
            keymap = {
                preset = 'default',
                ['<CR>'] = { 'accept', 'fallback' },
            },
            completion = {
                menu = {
                    auto_show = true,
                },
                list = {
                    selection = { preselect = false, auto_insert = true },
                },
            },
        },
    },
    {
        "smoka7/hop.nvim",
        opts = { create_hl_autocmd = false },
        keys = {
            {
                [[<leader>ew]],
                function()
                    -- hop types are incorrect
                    ---@diagnostic disable-next-line: missing-parameter
                    require("hop").hint_words()
                end,
            },
            {
                [[<leader>e/]],
                function()
                    -- hop types are incorrect
                    ---@diagnostic disable-next-line: missing-parameter
                    require("hop").hint_patterns()
                end,
            },
        },
        lazy = true,
    },
    {
        "sodiumjoe/sodium.nvim",
        -- dir = "~/home/sodium.nvim",
        -- dev = true,
        config = function()
            require("sodium")
            vim.cmd.colorscheme("sodium-dark")
            local line_nr_autocmd = utils.augroup("LineNr", { clear = true })
            -- disable line number in these filetypes
            line_nr_autocmd("FileType", {
                pattern = { "dirvish", "help" },
                callback = function()
                    vim.opt_local.number = false
                end,
            })
            -- disable line number in empty buffer
            line_nr_autocmd({ "BufNewFile", "BufRead", "BufEnter" }, {
                pattern = "*",
                callback = function()
                    if vim.filetype.match({ buf = 0 }) == nil then
                        vim.opt_local.number = false
                    else
                        vim.opt_local.number = true
                    end
                end,
            })
            local cursorline_autocomd = utils.augroup("CurrentBufferCursorline", { clear = true })
            -- enable cursorline line number highlight in active window
            cursorline_autocomd({ "VimEnter", "WinEnter", "BufWinEnter" }, {
                pattern = "*",
                callback = function()
                    vim.opt_local.cursorline = true
                end,
            })
            -- disable cursorline line number highlight in inactive windows
            cursorline_autocomd({ "WinLeave" }, {
                pattern = "*",
                callback = function()
                    vim.opt_local.cursorline = false
                end,
            })
        end,
    },
    {
        "tpope/vim-eunuch",
        cmd = {
            "Remove",
            "Delete",
            "Move",
            "Chmod",
            "Mkdir",
            "Cfind",
            "Clocate",
            "Wall",
            "SudoWrite",
            "SudoEdit",
        },
    },
    {
        "tpope/vim-fugitive",
        cmd = { "Gdiffsplit", "Git" },
    },
    "tpope/vim-repeat",
    "tpope/vim-surround",
}, {
    -- leave nil when passing the spec as the first argument to setup()
    lockfile = "~/.dotfiles/lazy-lock.json",
    dev = {
        -- directory where you store your local plugin projects
        path = "~/home",
        -- --@type string[] plugins that match these patterns will use your local versions instead of being fetched from GitHub
        -- patterns = { "sodiumjoe" }, -- For example {"folke"}
    },
    install = {
        -- install missing plugins on startup. This doesn't increase startup time.
        missing = true,
        -- try to load one of these colorschemes when starting an installation during startup
        colorscheme = { "sodium" },
    },
    performance = {
        rtp = {
            paths = { "~/.dotfiles/neovim" }, -- add any custom paths here that you want to includes in the rtp
        },
    },
})
