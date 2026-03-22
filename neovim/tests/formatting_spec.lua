local formatting = require("sodium.config.lsp.formatting")

describe("sodium.config.lsp.formatting", function()
    describe("format", function()
        local original_get_clients
        local original_buf_format
        local format_opts

        before_each(function()
            original_get_clients = vim.lsp.get_clients
            original_buf_format = vim.lsp.buf.format
            format_opts = nil
            vim.lsp.buf.format = function(opts)
                format_opts = opts
            end
        end)

        after_each(function()
            vim.lsp.get_clients = original_get_clients
            vim.lsp.buf.format = original_buf_format
        end)

        it("prefers efm when attached", function()
            vim.lsp.get_clients = function(filter)
                if filter and filter.name == "efm" then
                    return { { name = "efm" } }
                end
                return {}
            end

            formatting.format(0)

            assert.is_not_nil(format_opts)
            assert.are.equal("efm", format_opts.name)
            assert.are.equal(30000, format_opts.timeout_ms)
        end)

        it("passes nil name when efm not attached", function()
            vim.lsp.get_clients = function()
                return {}
            end

            formatting.format(0)

            assert.is_not_nil(format_opts)
            assert.is_nil(format_opts.name)
            assert.are.equal(30000, format_opts.timeout_ms)
        end)
    end)
end)
