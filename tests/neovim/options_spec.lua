describe("options", function()
    it("disables ShaDa in Plenary workers", function()
        assert.are.equal("NONE", vim.o.shadafile)
    end)

    describe("diffopt", function()
        it("keeps modern diff alignment options for readable review diffs", function()
            local opts = {}
            for _, opt in ipairs(vim.split(vim.o.diffopt, ",")) do
                opts[opt] = true
            end

            assert.is_true(opts["internal"])
            assert.is_true(opts["filler"])
            assert.is_true(opts["vertical"])
            assert.is_true(opts["indent-heuristic"])
            assert.is_true(opts["inline:char"])
            assert.is_true(opts["linematch:40"])
            assert.is_true(opts["algorithm:patience"])
        end)
    end)

    describe("Neovim 0.12 APIs", function()
        it("does not use the deprecated buffer option key", function()
            local root = vim.env.DOTFILES_TEST_ROOT or vim.fn.expand("~/.dotfiles")
            local files = {
                "home/.config/nvim/lua/sodium/config/lsp/formatting.lua",
                "home/.config/nvim/lua/sodium/plugins/agentic.lua",
            }

            for _, file in ipairs(files) do
                local source = table.concat(vim.fn.readfile(root .. "/" .. file), "\n")
                assert.is_nil(source:match("[{,]%s*buffer%s*="), file)
            end
        end)
    end)
end)
