local colorscheme = require("sodium.config.colorscheme")

describe("colorscheme", function()
    describe("palette", function()
        it("has all required base colors", function()
            local required = {
                "black",
                "red",
                "green",
                "yellow",
                "blue",
                "magenta",
                "cyan",
                "white",
                "orange",
                "pink",
                "comment",
            }
            for _, name in ipairs(required) do
                assert.is_not_nil(colorscheme.palette[name], "missing palette color: " .. name)
                assert.matches(
                    "^#%x%x%x%x%x%x$",
                    colorscheme.palette[name],
                    "invalid hex for " .. name .. ": " .. colorscheme.palette[name]
                )
            end
        end)

        it("has all required shade colors", function()
            local required = { "bg0", "bg1", "bg2", "bg3", "bg4", "fg0", "fg1", "fg2", "fg3", "sel0", "sel1" }
            for _, name in ipairs(required) do
                assert.is_not_nil(colorscheme.palette[name], "missing palette shade: " .. name)
            end
        end)
    end)

    describe("spec", function()
        it("has syntax semantics", function()
            local required = { "keyword", "func", "string", "comment", "const", "type", "variable", "operator" }
            for _, name in ipairs(required) do
                assert.is_not_nil(colorscheme.spec.syntax[name], "missing syntax spec: " .. name)
            end
        end)

        it("has diagnostic semantics", function()
            local required = { "error", "warn", "info", "hint", "ok" }
            for _, name in ipairs(required) do
                assert.is_not_nil(colorscheme.spec.diag[name], "missing diag spec: " .. name)
            end
        end)

        it("has git semantics", function()
            local required = { "add", "removed", "changed" }
            for _, name in ipairs(required) do
                assert.is_not_nil(colorscheme.spec.git[name], "missing git spec: " .. name)
            end
        end)
    end)

    describe("highlights", function()
        it("defines core editor groups", function()
            local required = {
                "Normal",
                "NormalFloat",
                "Visual",
                "Search",
                "CursorLine",
                "StatusLine",
                "Pmenu",
                "FloatBorder",
                "LineNr",
            }
            for _, name in ipairs(required) do
                assert.is_not_nil(colorscheme.highlights[name], "missing highlight: " .. name)
            end
        end)

        it("defines vim syntax groups", function()
            local required = {
                "Comment",
                "String",
                "Function",
                "Keyword",
                "Type",
                "Identifier",
                "Constant",
                "Operator",
                "PreProc",
            }
            for _, name in ipairs(required) do
                assert.is_not_nil(colorscheme.highlights[name], "missing highlight: " .. name)
            end
        end)

        it("defines treesitter groups", function()
            local required = {
                "@variable",
                "@function",
                "@keyword",
                "@string",
                "@type",
                "@comment",
                "@property",
                "@constructor",
            }
            for _, name in ipairs(required) do
                assert.is_not_nil(colorscheme.highlights[name], "missing highlight: " .. name)
            end
        end)

        it("defines diagnostic groups", function()
            local required = {
                "DiagnosticError",
                "DiagnosticWarn",
                "DiagnosticInfo",
                "DiagnosticHint",
                "DiagnosticUnderlineError",
                "DiagnosticUnderlineWarn",
            }
            for _, name in ipairs(required) do
                assert.is_not_nil(colorscheme.highlights[name], "missing highlight: " .. name)
            end
        end)

        it("defines custom statusline groups", function()
            local required = {
                "StatusLineActiveItem",
                "StatusLineError",
                "StatusLineWarning",
                "StatusLineSeparator",
            }
            for _, name in ipairs(required) do
                assert.is_not_nil(colorscheme.highlights[name], "missing highlight: " .. name)
            end
        end)

        it("all non-link highlights reference valid hex colors", function()
            for name, opts in pairs(colorscheme.highlights) do
                if not opts.link then
                    for _, key in ipairs({ "fg", "bg", "sp" }) do
                        if opts[key] then
                            assert.matches(
                                "^#%x%x%x%x%x%x$",
                                opts[key],
                                name .. "." .. key .. " is not a valid hex color: " .. tostring(opts[key])
                            )
                        end
                    end
                end
            end
        end)
    end)

    describe("apply", function()
        it("sets Normal highlight", function()
            colorscheme.apply()
            local normal = vim.api.nvim_get_hl(0, { name = "Normal" })
            assert.is_not_nil(normal.fg)
            assert.is_not_nil(normal.bg)
        end)

        it("sets terminal colors", function()
            colorscheme.apply()
            assert.is_not_nil(vim.g.terminal_color_0)
            assert.is_not_nil(vim.g.terminal_color_15)
        end)
    end)
end)
