describe("options", function()
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
end)
