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

        it("uses the first formatting client when efm not attached", function()
            vim.lsp.get_clients = function(filter)
                if filter and filter.name == "efm" then
                    return {}
                end
                if filter and filter.method == "textDocument/formatting" then
                    return { { name = "ts_ls" } }
                end
                return {}
            end

            formatting.format(0)

            assert.is_not_nil(format_opts)
            assert.are.equal("ts_ls", format_opts.name)
            assert.is_true(format_opts.async)
            assert.are.equal(30000, format_opts.timeout_ms)
        end)
    end)
end)
