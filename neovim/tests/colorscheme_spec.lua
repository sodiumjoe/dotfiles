local specs = require("sodium.plugins.colorscheme")
for _, spec in ipairs(specs) do
    if spec[1] and spec[1]:find("nightfox") and spec.config then
        spec.config()
        break
    end
end

describe("colorscheme augroups", function()
    local has_augroup = function(name)
        local ok2 = pcall(vim.api.nvim_get_autocmds, { group = name })
        return ok2
    end

    describe("LineNr", function()
        it("augroup is registered", function()
            assert.is_true(has_augroup("LineNr"))
        end)

        it("disables line numbers for help filetype", function()
            if not has_augroup("LineNr") then return end
            local buf = vim.api.nvim_create_buf(false, true)
            vim.api.nvim_set_current_buf(buf)
            vim.opt_local.number = true
            vim.bo[buf].filetype = "help"
            vim.cmd("doautocmd FileType")
            assert.is_false(vim.opt_local.number:get())
            vim.api.nvim_buf_delete(buf, { force = true })
        end)

        it("disables line numbers for dirvish filetype", function()
            if not has_augroup("LineNr") then return end
            local buf = vim.api.nvim_create_buf(false, true)
            vim.api.nvim_set_current_buf(buf)
            vim.opt_local.number = true
            vim.bo[buf].filetype = "dirvish"
            vim.cmd("doautocmd FileType")
            assert.is_false(vim.opt_local.number:get())
            vim.api.nvim_buf_delete(buf, { force = true })
        end)

        it("enables line numbers for recognized filetypes", function()
            if not has_augroup("LineNr") then return end
            local buf = vim.api.nvim_create_buf(false, true)
            vim.api.nvim_set_current_buf(buf)
            vim.api.nvim_buf_set_name(buf, "test.lua")
            vim.cmd("doautocmd BufEnter")
            assert.is_true(vim.opt_local.number:get())
            vim.api.nvim_buf_delete(buf, { force = true })
        end)

        it("disables line numbers for unrecognized buffers", function()
            if not has_augroup("LineNr") then return end
            local buf = vim.api.nvim_create_buf(false, true)
            vim.api.nvim_set_current_buf(buf)
            vim.opt_local.number = true
            vim.cmd("doautocmd BufEnter")
            assert.is_false(vim.opt_local.number:get())
            vim.api.nvim_buf_delete(buf, { force = true })
        end)
    end)

    describe("CurrentBufferCursorline", function()
        it("augroup is registered", function()
            assert.is_true(has_augroup("CurrentBufferCursorline"))
        end)

        it("enables cursorline in active window", function()
            if not has_augroup("CurrentBufferCursorline") then return end
            vim.cmd("doautocmd WinEnter")
            assert.is_true(vim.opt_local.cursorline:get())
        end)

        it("disables cursorline when leaving window", function()
            if not has_augroup("CurrentBufferCursorline") then return end
            vim.cmd.vsplit()
            vim.cmd.wincmd("w")
            vim.cmd("doautocmd WinLeave")
            assert.is_false(vim.opt_local.cursorline:get())
            vim.cmd.wincmd("p")
            vim.cmd("doautocmd WinEnter")
            assert.is_true(vim.opt_local.cursorline:get())
            vim.cmd.only()
        end)
    end)
end)