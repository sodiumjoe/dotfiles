describe("plugin registry", function()
    local function collect_plugin_names(specs, names)
        names = names or {}
        if type(specs) == "string" then
            local name = specs:match("[^/]+$")
            if name then
                names[name] = { specs }
            end
            return names
        end
        if type(specs) ~= "table" then
            return names
        end
        if specs[1] and type(specs[1]) == "string" then
            local name = specs[1]:match("[^/]+$")
            if name then
                names[name] = specs
            end
            if specs.dependencies then
                for _, dep in ipairs(specs.dependencies) do
                    collect_plugin_names(dep, names)
                end
            end
            return names
        end
        for _, spec in ipairs(specs) do
            collect_plugin_names(spec, names)
        end
        return names
    end

    local all_plugins = {}
    local spec_modules = {
        "sodium.plugins.annotations",
        "sodium.plugins.colorscheme",
        "sodium.plugins.completion",
        "sodium.plugins.editing",
        "sodium.plugins.git",
        "sodium.plugins.lazydev",
        "sodium.plugins.markdown",
        "sodium.plugins.pickers",
        "sodium.plugins.treesitter",
        "sodium.plugins.ui",
    }

    for _, mod in ipairs(spec_modules) do
        local ok, specs = pcall(require, mod)
        if ok then
            collect_plugin_names(specs, all_plugins)
        end
    end

    local ok, lsp_specs = pcall(require, "sodium.plugins.lsp")
    if ok then
        collect_plugin_names(lsp_specs, all_plugins)
    end

    describe("expected plugins declared", function()
        local expected = {
            "snacks.nvim",
            "nightfox.nvim",
            "lualine.nvim",
            "statuscol.nvim",
            "nvim-colorizer.lua",
            "nvim-treesitter",
            "nvim-treesitter-context",
            "hop.nvim",
            "nvim-retrail",
            "vim-dirvish",
            "vim-eunuch",
            "vim-repeat",
            "vim-surround",
            "mini.move",
            "blink.cmp",
            "lspkind-nvim",
            "friendly-snippets",
            "nvim-lspconfig",

            "lazydev.nvim",
            "vim-fugitive",
            "nvim-comment-overlay",
            "vim-signify",
            "render-markdown.nvim",
            "obsidian.nvim",
        }

        for _, name in ipairs(expected) do
            it("declares " .. name, function()
                assert.is_not_nil(all_plugins[name], name .. " not found in specs")
            end)
        end
    end)

    describe("disabled plugins", function()
        it("sodium.nvim is disabled", function()
            local spec = all_plugins["sodium.nvim"]
            if spec then
                assert.is_false(spec.enabled ~= false)
            end
        end)
    end)

    describe("conditional plugins", function()
        it("agentic.nvim declared in spec", function()
            local ok2, agentic_specs = pcall(require, "sodium.plugins.agentic")
            if ok2 then
                local agentic_plugins = collect_plugin_names(agentic_specs)
                assert.is_not_nil(agentic_plugins["agentic.nvim"])
            end
        end)
    end)
end)
