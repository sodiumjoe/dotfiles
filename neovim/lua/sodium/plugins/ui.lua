return {
    {
        "nvim-lualine/lualine.nvim",
        config = function()
            require("sodium.statusline")
        end,
        lazy = false,
    },
    {
        "luukvbaal/statuscol.nvim",
        config = function()
            local builtin = require("statuscol.builtin")

            -- Diff gutter: show colored │ for diff lines (like signify does for git changes)
            local function diff_sign(args)
                if not vim.wo[args.win].diff then
                    return " "
                end
                -- Filler lines (deletions on other side) show as DiffDelete
                if vim.fn.diff_filler(args.lnum) > 0 then
                    return "%#DiffSignDelete#│%*"
                end
                local hl = vim.fn.diff_hlID(args.lnum, 1)
                if hl == 0 then
                    return " "
                end
                local name = vim.fn.synIDattr(hl, "name")
                if name == "DiffAdd" then
                    return "%#DiffSignAdd#│%*"
                elseif name == "DiffChange" or name == "DiffText" then
                    return "%#DiffSignChange#│%*"
                elseif name == "DiffDelete" then
                    return "%#DiffSignDelete#│%*"
                end
                return " "
            end

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
                        condition = {
                            function(args)
                                return not vim.wo[args.win].diff
                            end,
                        },
                    },
                    {
                        text = { diff_sign },
                        condition = {
                            function(args)
                                return vim.wo[args.win].diff
                            end,
                        },
                    },
                    { text = { " " } },
                },
            })
        end,
    },
    {
        "catgoose/nvim-colorizer.lua",
        event = "BufReadPre",
        opts = {
            user_default_options = {
                names = false,
                names_custom = require("sodium.config.colorscheme").palette,
            },
        },
    },
    {
        "onsails/lspkind-nvim",
        lazy = true,
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
    "rhysd/conflict-marker.vim",
}
