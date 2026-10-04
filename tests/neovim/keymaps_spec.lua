describe("keymaps", function()
    local function find_nmap(lhs)
        for _, m in ipairs(vim.api.nvim_get_keymap("n")) do
            if m.lhs == lhs then
                return m
            end
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

        it("maps review keymaps in core config", function()
            assert.is_not_nil(find_nmap(" pf"))
            assert.is_not_nil(find_nmap(" pn"))
            assert.is_not_nil(find_nmap(" pa"))
            assert.is_not_nil(find_nmap(" px"))
            assert.is_not_nil(find_nmap(" ps"))
            assert.is_not_nil(find_nmap(" p?"))
        end)

        it("registers the Review command", function()
            assert.is_truthy(vim.api.nvim_get_commands({})["Review"])
        end)
    end)

    describe("plugin keymaps (declared in specs)", function()
        local function spec_has_key(specs, lhs)
            if type(specs) ~= "table" then
                return false
            end
            if specs[1] and type(specs[1]) == "string" then
                if specs.keys then
                    for _, key in ipairs(specs.keys) do
                        local key_lhs = type(key) == "table" and key[1] or key
                        if key_lhs == lhs then
                            return true
                        end
                    end
                end
                return false
            end
            for _, spec in ipairs(specs) do
                if spec_has_key(spec, lhs) then
                    return true
                end
            end
            return false
        end

        local function find_spec_key(specs, lhs)
            if type(specs) ~= "table" then
                return nil
            end
            if specs[1] and type(specs[1]) == "string" then
                if specs.keys then
                    for _, key in ipairs(specs.keys) do
                        local key_lhs = type(key) == "table" and key[1] or key
                        if key_lhs == lhs then
                            return key
                        end
                    end
                end
                return nil
            end
            for _, spec in ipairs(specs) do
                local key = find_spec_key(spec, lhs)
                if key then
                    return key
                end
            end
            return nil
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
            it("does not discover models during lazy initialization", function()
                local model_catalog = require("sodium.agentic_models")
                local original = model_catalog.discover
                local original_autocmd = vim.api.nvim_create_autocmd
                local callbacks = {}
                local calls = 0
                model_catalog.discover = function()
                    calls = calls + 1
                end
                vim.api.nvim_create_autocmd = function(event, opts)
                    if event == "VimEnter" then callbacks[#callbacks + 1] = opts.callback end
                    return 1
                end
                if agentic.init then agentic.init() end
                for _, callback in ipairs(callbacks) do callback() end
                vim.api.nvim_create_autocmd = original_autocmd
                model_catalog.discover = original
                assert.are.equal(0, calls)
            end)

            it("routes Agency mappings and preserves native restore and note mappings", function()
                local targets = {
                    ["<leader>ac"] = "current", ["<leader>an"] = "new", ["<leader>af"] = "roster",
                    ["<leader>as"] = "stop", ["<leader>ao"] = "open", ["<leader>aa"] = "add_context",
                    ["<leader>ad"] = "add_diagnostics", ["<leader>aD"] = "add_diagnostics",
                    ["<leader>ai"] = "submit_text",
                }
                local original = package.loaded["sodium.agency"]
                local routed = {}
                local api = {}
                for _, target in pairs(targets) do
                    api[target] = function(...)
                        routed[#routed + 1] = { target, ... }
                    end
                end
                package.loaded["sodium.agency"] = api
                local ok2, err = pcall(function()
                    for lhs, target in pairs(targets) do
                        local key = assert(find_spec_key(agentic, lhs))
                        key[2]()
                        assert.are.equal(target, routed[#routed][1])
                    end
                    for _, lhs in ipairs({ "<leader>ar", "<leader>ap", "<leader>aP", "<leader>at", "<leader>st", "<leader>sT", "<leader>pr", "<leader>a=" }) do
                        assert.is_true(spec_has_key(agentic, lhs))
                    end
                    assert.is_true(vim.tbl_contains(agentic.cmd, "AgencyCurrent"))
                end)
                package.loaded["sodium.agency"] = original
                assert.is_true(ok2, err)
            end)

            it("declares leader-pr in agentic spec", function()
                assert.is_true(spec_has_key(agentic, "<leader>pr"))
            end)

            it("does not declare review file keymaps in agentic spec", function()
                assert.is_false(spec_has_key(agentic, "<leader>pf"))
                assert.is_false(spec_has_key(agentic, "<leader>pn"))
                assert.is_false(spec_has_key(agentic, "<leader>pa"))
            end)
        end

        local markdown = require("sodium.plugins.markdown")

        it("declares leader-wp in markdown spec", function()
            assert.is_true(spec_has_key(markdown, "<leader>wp"))
        end)

        it("declares leader-ww in markdown spec", function()
            assert.is_true(spec_has_key(markdown, "<leader>ww"))
        end)

        local lsp_keymaps = require("sodium.plugins.lsp.keymaps")

        it("declares leader-f in lsp keymaps spec", function()
            assert.is_true(spec_has_key(lsp_keymaps, "<leader>f"))
        end)

        it("declares leader-ca in lsp keymaps spec", function()
            assert.is_true(spec_has_key(lsp_keymaps, "<leader>ca"))
        end)
    end)
end)