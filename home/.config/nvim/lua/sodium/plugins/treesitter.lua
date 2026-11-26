return {
    {
        "nvim-treesitter/nvim-treesitter",
        branch = "main",
        build = ":TSUpdate",
        lazy = false,
        config = function()
            vim.api.nvim_create_autocmd("FileType", {
                callback = function(args)
                    local ft = vim.bo[args.buf].filetype
                    if vim.bo[args.buf].buftype ~= "" and ft ~= "AgenticChat" then
                        return
                    end
                    local lang = vim.treesitter.language.get_lang(ft)
                    if not lang or not pcall(vim.treesitter.language.inspect, lang) then
                        return
                    end
                    if ft ~= "AgenticChat" then
                        vim.treesitter.start(args.buf)
                        return
                    end
                    local sources = {}
                    for _, path in ipairs(vim.treesitter.query.get_files(lang, "highlights")) do
                        sources[#sources + 1] = table.concat(vim.fn.readfile(path), "\n")
                    end
                    local query = table.concat(sources, "\n"):gsub('%(#set! conceal_lines ""%)', "")
                    local parser = vim.treesitter.get_parser(args.buf, lang)
                    local highlighter = vim.treesitter.highlighter.new(parser, { queries = { [lang] = query } })
                    local parse = parser.parse
                    parser.parse = function(self, range, on_parse)
                        if not on_parse then
                            return parse(self, range)
                        end
                        return parse(self, range, function(err, trees)
                            on_parse(err, trees)
                            if
                                err
                                and highlighter.parsing
                                and vim.treesitter.highlighter.active[args.buf] == highlighter
                            then
                                highlighter.parsing = false
                                vim.api.nvim__redraw({ buf = args.buf, valid = false, flush = false })
                            end
                        end)
                    end
                end,
            })
        end,
        keys = {
            {
                [[<leader>h]],
                function()
                    local ts_result = vim.treesitter.get_captures_at_cursor(0)
                    local lsp_result = vim.lsp.semantic_tokens.get_at_pos()
                    print(vim.inspect({ ts = ts_result, lsp = lsp_result }))
                end,
                desc = "Inspect treesitter and LSP highlights",
            },
        },
    },
    "nvim-treesitter/nvim-treesitter-context",
}
