return {
    all = {
        CursorLine = { bg = "palette.bg0" },
        LineNr = { fg = "palette.bg2" },
        CursorLineNr = { fg = "palette.pink", style = "bold" },

        StatusLine = { fg = "palette.white", bg = "palette.bg2" },
        StatusLineNC = { fg = "palette.fg1", bg = "palette.bg2" },
        StatusLineActiveItem = { fg = "palette.black", bg = "palette.fg1" },
        StatusLineError = { fg = "palette.red", bg = "palette.bg2" },
        StatusLineWarning = { fg = "palette.orange", bg = "palette.bg2" },
        StatusLineSeparator = { fg = "palette.black", bg = "palette.bg2" },

        VertSplit = { fg = "fg2" },
        WinSeparator = { fg = "fg2" },

        DiagnosticError = { fg = "bg1", bg = "diag.error" },
        DiagnosticWarn = { fg = "bg1", bg = "diag.warn" },
        DiagnosticInfo = { fg = "bg1", bg = "diag.info" },
        DiagnosticHint = { fg = "bg1", bg = "diag.hint" },

        DiagnosticVirtualTextError = { link = "DiagnosticError" },
        DiagnosticVirtualTextWarn = { link = "DiagnosticWarn" },
        DiagnosticVirtualTextInfo = { link = "DiagnosticInfo" },
        DiagnosticVirtualTextHint = { link = "DiagnosticHint" },

        DiagnosticUnderlineError = { style = "undercurl", sp = "diag.error" },
        DiagnosticUnderlineWarn = { style = "undercurl", sp = "diag.warn" },
        DiagnosticUnderlineInfo = { style = "undercurl", sp = "diag.info" },
        DiagnosticUnderlineHint = { style = "undercurl", sp = "diag.hint" },

        DiagnosticFloatingError = { link = "ErrorMsg" },
        DiagnosticFloatingWarn = { link = "WarningMsg" },
        DiagnosticFloatingInfo = { link = "InfoMsg" },
        DiagnosticFloatingHint = { link = "HintMsg" },

        DiagnosticVirtualLinesError = { link = "DiagnosticFloatingError" },
        DiagnosticVirtualLinesWarn = { link = "DiagnosticFloatingWarn" },
        DiagnosticVirtualLinesInfo = { link = "DiagnosticFloatingInfo" },
        DiagnosticVirtualLinesHint = { link = "DiagnosticFloatingHint" },

        DiagnosticSignError = { link = "DiagnosticFloatingError" },
        DiagnosticSignWarn = { link = "DiagnosticFloatingWarn" },
        DiagnosticSignInfo = { link = "DiagnosticFloatingInfo" },
        DiagnosticSignHint = { link = "DiagnosticFloatingHint" },

        DiffAdd = { fg = "bg1", bg = "git.add" },
        DiffChange = { fg = "bg1", bg = "git.changed" },
        DiffDelete = { fg = "bg1", bg = "git.removed" },
        DiffText = { fg = "bg1", bg = "palette.yellow" },

        TreesitterContextLineNumber = { fg = "palette.fg0" },
    },
}
