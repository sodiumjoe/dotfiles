describe("keymaps", function()
    local function find_nmap(lhs)
        for _, m in ipairs(vim.api.nvim_get_keymap("n")) do
            if m.lhs == lhs then return m end
        end
        return nil
    end

    describe("core keymaps", function()
        it("maps j to gj", function()
            local m = find_nmap("j")
            assert.is_not_nil(m)
            assert.are.equal("gj", m.rhs)
        end)

        it("maps k to gk", function()
            local m = find_nmap("k")
            assert.is_not_nil(m)
            assert.are.equal("gk", m.rhs)
        end)

        it("maps leader-cr for relative path copy", function()
            local m = find_nmap(" cr")
            assert.is_not_nil(m)
            assert.is_truthy(m.rhs:find("expand"))
        end)

        it("maps leader-cf for full path copy", function()
            local m = find_nmap(" cf")
            assert.is_not_nil(m)
            assert.is_truthy(m.rhs:find("expand"))
        end)
    end)

    describe("plugin keymaps (declared in specs)", function()
        local function spec_has_key(specs, lhs)
            if type(specs) ~= "table" then return false end
            if specs[1] and type(specs[1]) == "string" then
                if specs.keys then
                    for _, key in ipairs(specs.keys) do
                        local key_lhs = type(key) == "table" and key[1] or key
                        if key_lhs == lhs then return true end
                    end
                end
                return false
            end
            for _, spec in ipairs(specs) do
                if spec_has_key(spec, lhs) then return true end
            end
            return false
        end

        local pickers = require("sodium.plugins.pickers")
        local editing = require("sodium.plugins.editing")

        it("declares C-p in pickers spec", function()
            assert.is_true(spec_has_key(pickers, "<C-p>"))
        end)

        it("declares leader-/ in pickers spec", function()
            assert.is_true(spec_has_key(pickers, "<leader>/"))
        end)

        it("declares leader-sb in pickers spec", function()
            assert.is_true(spec_has_key(pickers, "<leader>sb"))
        end)

        it("declares leader-ew in editing spec", function()
            assert.is_true(spec_has_key(editing, "<leader>ew"))
        end)

        it("declares leader-e/ in editing spec", function()
            assert.is_true(spec_has_key(editing, "<leader>e/"))
        end)

        local ok, agentic = pcall(require, "sodium.plugins.agentic")
        if ok then
            it("declares leader-a= in agentic spec", function()
                assert.is_true(spec_has_key(agentic, "<leader>a="))
            end)
        end

        local git = require("sodium.plugins.git")

        it("declares leader-pr in git spec", function()
            assert.is_true(spec_has_key(git, "<leader>pr"))
        end)

        it("declares leader-pf in git spec", function()
            assert.is_true(spec_has_key(git, "<leader>pf"))
        end)

        it("declares leader-pd in git spec", function()
            assert.is_true(spec_has_key(git, "<leader>pd"))
        end)

        it("declares leader-px in git spec", function()
            assert.is_true(spec_has_key(git, "<leader>px"))
        end)

        it("declares leader-pn in git spec", function()
            assert.is_true(spec_has_key(git, "<leader>pn"))
        end)

        local markdown = require("sodium.plugins.markdown")

        it("declares leader-wp in markdown spec", function()
            assert.is_true(spec_has_key(markdown, "<leader>wp"))
        end)

        it("declares leader-ww in markdown spec", function()
            assert.is_true(spec_has_key(markdown, "<leader>ww"))
        end)
    end)
end)