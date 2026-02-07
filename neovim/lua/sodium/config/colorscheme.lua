local M = {}

M.palette = {
    black = "#3C4C55",
    red = "#DF8C8C",
    green = "#A8CE93",
    yellow = "#DADA93",
    blue = "#83AFE5",
    magenta = "#9A93E1",
    cyan = "#7FC1CA",
    white = "#E6EEF3",
    orange = "#F2C38F",
    pink = "#D18EC2",

    comment = "#899BA6",

    bg0 = "#3C4C55",
    bg1 = "#3C4C55",
    bg2 = "#556873",
    bg3 = "#556873",
    bg4 = "#6A7D89",

    fg0 = "#E6EEF3",
    fg1 = "#C5D4DD",
    fg2 = "#899BA6",
    fg3 = "#6A7D89",

    sel0 = "#556873",
    sel1 = "#6A7D89",
}

M.spec = {
    syntax = {
        bracket = "orange",
        builtin0 = "pink",
        conditional = "orange",
        const = "cyan",
        field = "orange",
        func = "pink",
        ident = "blue",
        keyword = "magenta",
        number = "magenta",
        operator = "fg1",
        preproc = "magenta",
        statement = "#7399C8",
        string = "fg1",
    },
    diag = {
        warn = "orange",
        info = "yellow",
        hint = "yellow",
    },
    git = {
        changed = "orange",
    },
}

M.groups = {
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
}

return M
