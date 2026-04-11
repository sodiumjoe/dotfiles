local colorscheme = require("sodium.config.colorscheme")
local p = colorscheme.palette
local git = colorscheme.spec.git

describe("diff mode highlights", function()
    before_each(function()
        colorscheme.apply()
    end)

    it("defines DiffSign highlight groups", function()
        local required = { "DiffSignAdd", "DiffSignChange", "DiffSignDelete" }
        for _, name in ipairs(required) do
            assert.is_not_nil(colorscheme.highlights[name], "missing highlight: " .. name)
        end
    end)

    it("DiffSign groups use git colors with no background", function()
        assert.equals(git.add, colorscheme.highlights.DiffSignAdd.fg)
        assert.equals(git.changed, colorscheme.highlights.DiffSignChange.fg)
        assert.equals(git.removed, colorscheme.highlights.DiffSignDelete.fg)
        assert.is_nil(colorscheme.highlights.DiffSignAdd.bg)
        assert.is_nil(colorscheme.highlights.DiffSignChange.bg)
        assert.is_nil(colorscheme.highlights.DiffSignDelete.bg)
    end)

    it("default Diff highlights have solid backgrounds", function()
        local hl = vim.api.nvim_get_hl(0, { name = "DiffAdd" })
        assert.is_not_nil(hl.bg, "DiffAdd should have bg in normal mode")
    end)

    describe("autocmd swap", function()
        local function get_hl_bg(name)
            return vim.api.nvim_get_hl(0, { name = name }).bg
        end

        it("removes DiffAdd/DiffChange bg when diff mode activates", function()
            require("sodium.config.autocmds")
            -- Simulate diff mode activation
            local buf = vim.api.nvim_create_buf(false, true)
            vim.api.nvim_set_current_buf(buf)
            vim.wo.diff = true
            vim.api.nvim_exec_autocmds("OptionSet", { pattern = "diff" })

            assert.is_nil(get_hl_bg("DiffAdd"), "DiffAdd bg should be nil in diff mode")
            assert.is_nil(get_hl_bg("DiffChange"), "DiffChange bg should be nil in diff mode")

            -- DiffText should use bg2
            local diff_text_bg = get_hl_bg("DiffText")
            assert.is_not_nil(diff_text_bg, "DiffText should have subtle bg in diff mode")

            -- Cleanup
            vim.wo.diff = false
            vim.api.nvim_buf_delete(buf, { force = true })
        end)

        it("restores solid backgrounds when diff mode deactivates", function()
            require("sodium.config.autocmds")
            local buf = vim.api.nvim_create_buf(false, true)
            vim.api.nvim_set_current_buf(buf)

            -- Enter diff mode
            vim.wo.diff = true
            vim.api.nvim_exec_autocmds("OptionSet", { pattern = "diff" })

            -- Exit diff mode
            vim.wo.diff = false
            vim.api.nvim_exec_autocmds("OptionSet", { pattern = "diff" })

            assert.is_not_nil(get_hl_bg("DiffAdd"), "DiffAdd bg should be restored")
            assert.is_not_nil(get_hl_bg("DiffChange"), "DiffChange bg should be restored")

            vim.api.nvim_buf_delete(buf, { force = true })
        end)
    end)
end)
