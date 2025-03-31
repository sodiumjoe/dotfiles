vim.g.popup_opts = {
    focusable = false,
    border = "rounded",
}

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

local autoformat_augroup = vim.api.nvim_create_augroup("LspFormatting", {})

require("lazy").setup({
    {
        "rktjmp/shipwright.nvim",
        cmd = { "Shipwright" },
        dependencies = {
            { "rktjmp/lush.nvim", lazy = true },
        },
    },
    {
        "benizi/vim-automkdir",
        event = "BufWritePre",
    },
    {
        "catgoose/nvim-colorizer.lua",
        event = "BufReadPre",
    },
    {
        "davidosomething/format-ts-errors.nvim",
        config = function()
            require("format-ts-errors").setup({
                add_markdown = true,    -- wrap output with markdown ```ts ``` markers
                start_indent_level = 0, -- initial indent
            })
        end,
    },
    {
        "echasnovski/mini.move",
        version = "*",
        config = function()
            require("mini.move").setup({
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
            })
        end,
        keys = { "<C-j>", "<C-k>", "v", "V", "<C-v>" },
        dependencies = {
            { "echasnovski/mini.nvim", version = "*" },
        },
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
    },
    {
        "folke/snacks.nvim",
        priority = 1000,
        lazy = false,
        opts = {
            picker = {
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
                        on_show = function() vim.cmd.stopinsert() end,
                    })
                end,
                desc = "Find Files",
            },
            -- find
            {
                "<leader>g",
                function()
                    Snacks.picker.git_status({
                        on_show = function() vim.cmd.stopinsert() end,
                    })
                end,
                desc = "Git Status",
            },
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
        "junegunn/goyo.vim",
        config = function()
            vim.cmd([[
        function! s:goyo_enter()
          set linebreak
        endfunction

        function! s:goyo_leave()
          set nolinebreak
        endfunction

        autocmd! User GoyoEnter nested call <SID>goyo_enter()
        autocmd! User GoyoLeave nested call <SID>goyo_leave()
      ]])
        end,
        cmd = { "Goyo" },
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
        "kevinhwang91/nvim-hlslens",
        init = function()
            vim.o.hlsearch = true
        end,
        config = function()
            require("hlslens").setup({
                calm_down = true,
                nearest_only = false,
            })
        end,
        keys = {
            { 'n',  [[<Cmd>execute('normal! ' . v:count1 . 'n')<CR><Cmd>/ua require('hlslens').start()<CR>]] },
            { 'N',  [[<Cmd>execute('normal! ' . v:count1 . 'N')<CR><Cmd>lua require('hlslens').start()<CR>]] },
            { '*',  [[*<Cmd>lua require('hlslens').start()<CR>]] },
            { '#',  [[#<Cmd>lua require('hlslens').start()<CR>]] },
            { 'g*', [[g*<Cmd>lua require('hlslens').start()<CR>]] },
            { 'g#', [[g#<Cmd>lua require('hlslens').start()<CR>]] },
        },
    },
    -- {
    --     "L3MON4D3/p/LuaSnip",
    --     -- follow latest release.
    --     version = "v2.*", -- Replace <CurrentMajor> by the latest released major (first number of latest release)
    --     -- install jsregexp (optional!).
    --     -- build = "make install_jsregexp",
    --     dependencies = {
    --         { "rafamadriz/friendly-snippets", lazy = true },
    --     },
    --     config = function()
    --         require("luasnip.loaders.from_vscode").lazy_load()
    --         local ls = require("luasnip")
    --         local s = ls.snippet
    --         local t = ls.text_node
    --         local i = ls.insert_node
    --         local f = ls.function_node
    --         ls.add_snippets("rust", {
    --             s("debug", {
    --                 t([[tracing::debug!("]]),
    --                 i(1),
    --                 t([[: {:#?}", ]]),
    --                 f(function(args)
    --                     return args[1][1]
    --                 end, { 1 }),
    --                 t([[);]]),
    --             }),
    --         })
    --     end,
    -- },
    {
        "luukvbaal/statuscol.nvim",
        init = function()
            vim.diagnostic.config({ severity_sort = true })
        end,
        config = function()
            local builtin = require("statuscol.builtin")
            require("statuscol").setup({
                segments = {
                    {
                        text = { builtin.lnumfunc },
                        sign = { name = { "Diagnostic" } },
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
            local nvim_lsp = require("lspconfig")
            local configs = require("lspconfig.configs")
            local lsp_status = require("lsp-status")
            local blink = require("blink.cmp")

            configs.bazel = {
                default_config = {
                    cmd = { "pay", "exec", "scripts/dev/bazel-lsp" },
                    filetypes = { "star", "bzl", "BUILD.bazel" },
                    root_dir = utils.find_git_ancestor,
                },
                docs = {
                    description = [[]],
                },
            }

            configs.vtsls = require("vtsls").lspconfig

            vim.diagnostic.config({
                signs = { priority = 11 },
                virtual_text = false,
                virtual_lines = true,
                update_in_insert = false,
                float = {
                    focusable = vim.g.popup_opts.focusable,
                    border = vim.g.popup_opts.border,
                    format = function(diagnostic)
                        local str = string.format("[%s] %s", diagnostic.source, diagnostic.message)
                        if diagnostic.code then
                            str = str .. " (" .. diagnostic.code .. ")"
                        end
                        return str
                    end,
                },
            })

            local on_attach = function(client, bufnr)
                lsp_status.on_attach(client)

                if client:supports_method("textDocument/formatting") then
                    vim.api.nvim_clear_autocmds({ group = autoformat_augroup, buffer = bufnr })
                    vim.api.nvim_create_autocmd("BufWritePre", {
                        group = autoformat_augroup,
                        buffer = bufnr,
                        callback = function()
                            vim.lsp.buf.format({ timeout_ms = 30000 })
                        end,
                    })
                end
                require("lspkind").init({})
            end

            local devbox_tsserver_path = "/pay/src/pay-server/frontend/js-scripts/node_modules/typescript/lib"

            local servers = {
                rust_analyzer = {
                    settings = {
                        ["rust-analyzer"] = {
                            cargo = {
                                features = "all",
                            },
                        },
                    },
                },
                bazel = {},
                sorbet = {
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
                },
                eslint = {
                    cmd_env = { BROWSERSLIST_IGNORE_OLD_DATA = "1" },
                    on_attach = function(client, bufnr)
                        vim.api.nvim_create_autocmd("BufWritePre", { buffer = bufnr, command = "EslintFixAll" })
                        on_attach(client, bufnr)
                    end,
                },
                flow = {},
                vtsls = {
                    settings = {
                        vtsls = vim.fn.isdirectory(devbox_tsserver_path) == 1 and {
                            typescript = {
                                globalTsdk = devbox_tsserver_path,
                            },
                        } or {
                            autoUseWorkspaceTsdk = true,
                        },
                        typescript = {
                            format = {
                                enable = false,
                            },
                        },
                        javascript = {
                            format = {
                                enable = false,
                            },
                        },
                    },
                    handlers = {
                        ["textDocument/publishDiagnostics"] = function(_, result, ctx)
                            if result.diagnostics == nil then return end
                            -- ignore some tsserver diagnostics
                            local idx = 1
                            while idx <= #result.diagnostics do
                                local entry = result.diagnostics[idx]

                                local formatter = require('format-ts-errors')[entry.code]
                                entry.message = formatter and formatter(entry.message) or entry.message

                                -- codes: https://github.com/microsoft/TypeScript/blob/main/src/compiler/diagnosticMessages.json
                                if entry.code == 80001 then
                                    -- { message = "File is a CommonJS module; it may be converted to an ES module.", }
                                    table.remove(result.diagnostics, idx)
                                else
                                    idx = idx + 1
                                end
                            end

                            vim.lsp.diagnostic.on_publish_diagnostics(
                                _,
                                result,
                                ctx
                            )
                        end,
                    },
                },
            }

            if utils.is_executable("lua-language-server") then
                servers.lua_ls = {
                    on_init = function(client)
                        client.config.settings.Lua = vim.tbl_deep_extend('force', client.config.settings.Lua or {}, {
                            runtime = {
                                version = 'LuaJIT',
                            },
                            workspace = {
                                checkThirdParty = false,
                                library = { vim.env.VIMRUNTIME },
                            },
                        })
                    end,
                }
            end

            for lsp, options in pairs(servers) do
                local defaults = {
                    on_attach = on_attach,
                    flags = {
                        debounce_text_changes = 150,
                    },
                    capabilities = vim.tbl_extend("keep", options.capabilities or {}, lsp_status.capabilities),
                }

                local setup_options = vim.tbl_extend("force", defaults, options)
                setup_options.capabilities = blink.get_lsp_capabilities(setup_options.capabilities)

                nvim_lsp[lsp].setup(setup_options)
            end
        end,
        keys = {
            { "gD",           vim.lsp.buf.declaration },
            { "K",            function() vim.lsp.buf.hover(vim.g.popup_opts) end },
            { "gi",           vim.lsp.buf.implementation },
            { [[<leader>D]],  vim.lsp.buf.type_definition },
            { [[<leader>ca]], vim.lsp.buf.code_action },
            { [[<leader>ee]], vim.diagnostic.open_float },
            {
                [[<leader>p]],
                function()
                    vim.diagnostic.jump({
                        count = 1,
                        severity = utils.get_highest_error_severity(),
                    })
                end,
            },
            {
                [[<leader>n]],
                function()
                    vim.diagnostic.jump({
                        count = -1,
                        severity = utils.get_highest_error_severity(),
                    })
                end,
            },
            {
                [[<leader><Space>n]],
                function()
                    vim.diagnostic.jump({ count = 1 })
                end,
            },
            {
                [[<leader><Space>p]],
                function()
                    vim.diagnostic.jump({ count = -1 })
                end,
            },
            {
                [[<leader>f]],
                function()
                    vim.lsp.buf.format({ timeout_ms = 30000 })
                end,
            },
        },
        dependencies = {
            {
                "nvim-lua/lsp-status.nvim",
                config = function()
                    require("sodium.statusline")
                end,
            },
            { "onsails/lspkind-nvim", lazy = true },
            "saghen/blink.cmp",
        },
    },
    {
        "nvim-treesitter/nvim-treesitter",
        build = ":TSUpdate",
        main = "nvim-treesitter.configs",
        opts = {
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
                    return not vim.api.nvim_buf_get_name(bufnr):match("^fugitive://")
                end,
                on_attach = function(client, bufnr)
                    if client:supports_method("textDocument/formatting") then
                        vim.api.nvim_clear_autocmds({ group = autoformat_augroup, buffer = bufnr })
                        vim.api.nvim_create_autocmd("BufWritePre", {
                            group = autoformat_augroup,
                            buffer = bufnr,
                            callback = function()
                                vim.lsp.buf.format({ timeout_ms = 30000 })
                            end,
                        })
                    end
                end,
            })
        end,
        dependencies = {
            "neovim/nvim-lspconfig",
            "nvim-lua/plenary.nvim",
        },
    },
    "rafamadriz/friendly-snippets",
    {
        "rachartier/tiny-devicons-auto-colors.nvim",
        dependencies = {
            "nvim-tree/nvim-web-devicons",
        },
        event = "VeryLazy",
        config = function()
            require("tiny-devicons-auto-colors").setup({
                colors = {
                    "#3C4C55",
                    "#556873",
                    "#6A7D89",
                    "#899BA6",
                    "#C5D4DD",
                    "#E6EEF3",
                    "#A76969",
                    "#DF8C8C",
                    "#E7A9A9",
                    "#F2C38F",
                    "#F5D2AB",
                    "#DADA93",
                    "#93B481",
                    "#A8CE93",
                    "#BEDAAE",
                    "#93B9E8",
                    "#83AFE5",
                    "#7399C8",
                    "#7FC1CA",
                    "#9A93E1",
                    "#B3AEE8",
                    "#D18EC2",
                    "#DDAAD1",
                    "#bb0099",
                    "#d5508f",
                },
            })
        end,
    },
    "rhysd/conflict-marker.vim",
    {
        "smoka7/hop.nvim",
        config = function()
            require("hop").setup({ create_hl_autocmd = false })
        end,
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
    },
    {
        'saghen/blink.cmp',
        lazy = false, -- lazy loading handled internally
        dependencies = 'rafamadriz/friendly-snippets',

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
                    border = 'rounded',
                    auto_show = true,
                },
                list = {
                    selection = { preselect = false, auto_insert = true },
                },
            },
        },
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
                pattern = { "vimwiki", "dirvish", "help" },
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
        "tpope/vim-commentary",
        keys = { "gcc", { "gc", mode = "v" } },
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
    {
        "vimwiki/vimwiki",
        init = function()
            local wiki = {
                path = "~/home/todo.wiki",
                syntax = "markdown",
            }
            local work_wiki = {
                path = "~/stripe/todo.wiki",
                path_html = "~/stripe/todo.html",
                syntax = "markdown",
            }

            if vim.fn.isdirectory(vim.fn.expand("~/stripe")) ~= 0 then
                vim.g.vimwiki_list = { work_wiki, wiki }
            else
                vim.g.vimwiki_list = { wiki }
            end
            vim.g.vimwiki_auto_header = 1
            vim.g.vimwiki_hl_headers = 1
            vim.g.vimwiki_hl_cb_checked = 1
            vim.g.vimwiki_listsyms = " ○◐●✓"
        end,
        keys = {
            { [[<leader>wp]], "<cmd>VimwikiDiaryPrevDay<cr>" },
            { [[<leader>wn]], "<Plug>VimwikiDiaryNextDay<cr>" },
            { [[<leader>wg]], "<cmd>VimwikiGoto<cr>" },
            { [[<leader>=]],  "<cmd>VimwikiAddHeaderLevel<cr>" },
            { [[<leader>-]],  "<cmd>VimwikiRemoveHeaderLevel<cr>" },
            "<leader>ww",
            "<leader>w<space>w",
        },
    },
    "yioneko/nvim-vtsls",
}, {
    defaults = {
        lazy = false,
    },
    -- leave nil when passing the spec as the first argument to setup()
    spec = nil, ---@type LazySpec
    lockfile = "~/.dotfiles/lazy-lock.json",
    dev = {
        -- directory where you store your local plugin projects
        path = "~/home",
        -- --@type string[] plugins that match these patterns will use your local versions instead of being fetched from GitHub
        -- patterns = { "sodiumjoe" }, -- For example {"folke"}
        fallback = false, -- Fallback to git when local plugin doesn't exist
    },
    install = {
        -- install missing plugins on startup. This doesn't increase startup time.
        missing = true,
        -- try to load one of these colorschemes when starting an installation during startup
        colorscheme = { "sodium" },
    },
    ui = {
        -- a number <1 is a percentage., >1 is a fixed size
        size = { width = 0.8, height = 0.8 },
        wrap = true, -- wrap the lines in the ui
        -- The border to use for the UI window. Accepts same border values as |nvim_open_win()|.
        border = "rounded",
    },
    performance = {
        cache = {
            enabled = true,
        },
        reset_packpath = true,                -- reset the package path to improve startup time
        rtp = {
            paths = { "~/.dotfiles/neovim" }, -- add any custom paths here that you want to includes in the rtp
        },
    },
})
