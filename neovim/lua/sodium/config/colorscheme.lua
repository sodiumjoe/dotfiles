local M = {}

-- ═══════════════════════════════════════════════════════════════════
-- Layer 1: Palette
-- ═══════════════════════════════════════════════════════════════════

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

local p = M.palette

-- ═══════════════════════════════════════════════════════════════════
-- Layer 2: Semantics
-- ═══════════════════════════════════════════════════════════════════

M.spec = {
    syntax = {
        bracket = p.orange,
        builtin0 = p.pink, -- builtin variables, return keyword
        builtin1 = p.cyan, -- builtin types, modules, special punctuation
        builtin2 = p.orange, -- builtin constants
        builtin3 = p.red, -- rare
        comment = p.comment,
        conditional = p.orange,
        const = p.cyan,
        dep = p.fg3, -- deprecated
        field = p.orange,
        func = p.pink,
        ident = p.blue,
        keyword = p.magenta,
        number = p.magenta,
        operator = p.fg1,
        preproc = p.magenta,
        regex = p.yellow,
        statement = "#7399C8",
        string = p.fg1,
        type = p.yellow,
        variable = p.fg1,
    },
    diag = {
        error = p.red,
        warn = p.orange,
        info = p.yellow,
        hint = p.yellow,
        ok = p.green,
    },
    git = {
        add = p.green,
        removed = p.red,
        changed = p.orange,
    },
}

local syn = M.spec.syntax
local diag = M.spec.diag
local git = M.spec.git

-- ═══════════════════════════════════════════════════════════════════
-- Layer 3: Highlights
-- ═══════════════════════════════════════════════════════════════════

M.highlights = {}
local h = M.highlights

-- ── Core Editor UI ───────────────────────────────────────────────

h.Normal = { fg = p.fg1, bg = p.bg1 }
h.NormalNC = { fg = p.fg1, bg = p.bg0 }
h.NormalFloat = { fg = p.fg1, bg = p.bg0 }
h.FloatBorder = { fg = p.fg3 }
h.ColorColumn = { bg = p.bg2 }
h.Conceal = { fg = p.bg4 }
h.Cursor = { fg = p.bg1, bg = p.fg1 }
h.lCursor = { link = "Cursor" }
h.CursorIM = { link = "Cursor" }
h.CursorColumn = { link = "CursorLine" }
h.CursorLine = { bg = p.bg0 }
h.Directory = { fg = syn.func }
h.EndOfBuffer = { fg = p.bg1 }
h.ErrorMsg = { fg = diag.error }
h.Folded = { fg = p.fg3, bg = p.bg2 }
h.FoldColumn = { fg = p.fg3 }
h.IncSearch = { fg = p.bg1, bg = diag.hint }
h.CurSearch = { link = "IncSearch" }
h.Search = { fg = p.fg1, bg = p.sel1 }
h.Substitute = { fg = p.bg1, bg = diag.error }
h.LineNr = { fg = p.bg2 }
h.CursorLineNr = { fg = p.pink, bold = true }
h.MatchParen = { fg = diag.warn, bold = true }
h.ModeMsg = { fg = diag.warn, bold = true }
h.MoreMsg = { fg = diag.info, bold = true }
h.NonText = { fg = p.bg4 }
h.Pmenu = { fg = p.fg1, bg = p.sel0 }
h.PmenuSel = { bg = p.sel1 }
h.PmenuSbar = { link = "Pmenu" }
h.PmenuThumb = { bg = p.sel1 }
h.PmenuBorder = { fg = p.fg2 }
h.Question = { link = "MoreMsg" }
h.QuickFixLine = { link = "CursorLine" }
h.SignColumn = { fg = p.fg3 }
h.SpecialKey = { link = "NonText" }
h.SpellBad = { sp = diag.error, undercurl = true }
h.SpellCap = { sp = diag.warn, undercurl = true }
h.SpellLocal = { sp = diag.info, undercurl = true }
h.SpellRare = { sp = diag.info, undercurl = true }
h.StatusLine = { fg = p.white, bg = p.bg2 }
h.StatusLineNC = { fg = p.fg1, bg = p.bg2 }
h.TabLine = { fg = p.fg2, bg = p.bg2 }
h.TabLineFill = { bg = p.bg0 }
h.TabLineSel = { fg = p.bg1, bg = p.fg3 }
h.Title = { fg = syn.func, bold = true }
h.Visual = { bg = p.sel0 }
h.VisualNOS = { link = "Visual" }
h.WarningMsg = { fg = diag.warn }
h.Whitespace = { fg = p.bg3 }
h.WildMenu = { link = "Pmenu" }
h.WinBar = { fg = p.fg3, bg = p.bg1, bold = true }
h.WinBarNC = { fg = p.fg3, bg = p.bg1, bold = true }
h.WinSeparator = { fg = p.fg2 }
h.VertSplit = { fg = p.fg2 }

-- ── Vim Syntax ───────────────────────────────────────────────────

h.Comment = { fg = syn.comment }
h.Constant = { fg = syn.const }
h.String = { fg = syn.string }
h.Character = { link = "String" }
h.Number = { fg = syn.number }
h.Float = { link = "Number" }
h.Boolean = { link = "Number" }
h.Identifier = { fg = syn.ident }
h.Function = { fg = syn.func }
h.Statement = { fg = syn.keyword }
h.Conditional = { fg = syn.conditional }
h.Repeat = { link = "Conditional" }
h.Label = { link = "Conditional" }
h.Operator = { fg = syn.operator }
h.Keyword = { fg = syn.keyword }
h.Exception = { link = "Keyword" }
h.PreProc = { fg = syn.preproc }
h.Include = { link = "PreProc" }
h.Define = { link = "PreProc" }
h.Macro = { link = "PreProc" }
h.PreCondit = { link = "PreProc" }
h.Type = { fg = syn.type }
h.StorageClass = { link = "Type" }
h.Structure = { link = "Type" }
h.Typedef = { link = "Type" }
h.Special = { fg = syn.func }
h.SpecialChar = { link = "Special" }
h.Tag = { link = "Special" }
h.Delimiter = { link = "Special" }
h.SpecialComment = { link = "Special" }
h.Debug = { link = "Special" }
h.Underlined = { underline = true }
h.Bold = { bold = true }
h.Italic = { italic = true }
h.Error = { fg = diag.error }
h.Todo = { fg = p.bg1, bg = diag.info }
h.qfLineNr = { link = "LineNr" }
h.qfFileName = { link = "Directory" }

-- Diff (vim syntax)
h.diffAdded = { fg = git.add }
h.diffRemoved = { fg = git.removed }
h.diffChanged = { fg = git.changed }
h.diffOldFile = { fg = diag.warn }
h.diffNewFile = { fg = diag.hint }
h.diffFile = { fg = diag.info }
h.diffLine = { fg = syn.builtin2 }
h.diffIndexLine = { fg = syn.preproc }

-- ── Treesitter ───────────────────────────────────────────────────

-- Variables
h["@variable"] = { fg = syn.variable }
h["@variable.builtin"] = { fg = syn.builtin0 }
h["@variable.parameter"] = { fg = syn.builtin1 }
h["@variable.member"] = { fg = syn.field }
h["@constant"] = { link = "Constant" }
h["@constant.builtin"] = { fg = syn.builtin2 }
h["@constant.macro"] = { link = "Macro" }
h["@module"] = { fg = syn.builtin1 }
h["@label"] = { link = "Label" }

-- Literals
h["@string"] = { link = "String" }
h["@string.regexp"] = { fg = syn.regex }
h["@string.escape"] = { fg = syn.regex, bold = true }
h["@string.special"] = { link = "Special" }
h["@string.special.url"] = { fg = syn.const, italic = true, underline = true }
h["@character"] = { link = "Character" }
h["@character.special"] = { link = "SpecialChar" }
h["@boolean"] = { link = "Boolean" }
h["@number"] = { link = "Number" }
h["@number.float"] = { link = "Float" }

-- Types
h["@type"] = { link = "Type" }
h["@type.builtin"] = { fg = syn.builtin1 }
h["@attribute"] = { link = "Constant" }
h["@property"] = { fg = syn.field }

-- Functions
h["@function"] = { link = "Function" }
h["@function.builtin"] = { fg = syn.builtin0 }
h["@function.macro"] = { fg = syn.builtin0 }
h["@constructor"] = { fg = syn.ident }
h["@operator"] = { link = "Operator" }

-- Keywords
h["@keyword"] = { link = "Keyword" }
h["@keyword.function"] = { fg = syn.keyword }
h["@keyword.operator"] = { fg = syn.operator }
h["@keyword.import"] = { link = "Include" }
h["@keyword.storage"] = { link = "StorageClass" }
h["@keyword.repeat"] = { link = "Repeat" }
h["@keyword.return"] = { fg = syn.builtin0 }
h["@keyword.exception"] = { link = "Exception" }
h["@keyword.conditional"] = { link = "Conditional" }
h["@keyword.conditional.ternary"] = { link = "Conditional" }

-- Punctuation
h["@punctuation.delimiter"] = { fg = syn.bracket }
h["@punctuation.bracket"] = { fg = syn.bracket }
h["@punctuation.special"] = { fg = syn.builtin1 }

-- Comments
h["@comment"] = { link = "Comment" }
h["@comment.error"] = { fg = p.bg1, bg = diag.error }
h["@comment.warning"] = { fg = p.bg1, bg = diag.warn }
h["@comment.todo"] = { fg = p.bg1, bg = diag.hint }
h["@comment.note"] = { fg = p.bg1, bg = diag.info }

-- Markup
h["@markup"] = { fg = p.fg1 }
h["@markup.strong"] = { fg = p.red, bold = true }
h["@markup.italic"] = { link = "Italic" }
h["@markup.strikethrough"] = { fg = p.fg1, strikethrough = true }
h["@markup.underline"] = { link = "Underlined" }
h["@markup.heading"] = { link = "Title" }
h["@markup.quote"] = { fg = p.fg2 }
h["@markup.math"] = { fg = syn.func }
h["@markup.link"] = { fg = syn.keyword, bold = true }
h["@markup.link.label"] = { link = "Special" }
h["@markup.link.url"] = { fg = syn.const, italic = true, underline = true }
h["@markup.raw"] = { fg = syn.ident, italic = true }
h["@markup.raw.block"] = { fg = p.pink }
h["@markup.list"] = { fg = syn.builtin1 }
h["@markup.list.checked"] = { fg = p.green }
h["@markup.list.unchecked"] = { fg = p.yellow }

-- Diff (treesitter)
h["@diff.plus"] = { link = "diffAdded" }
h["@diff.minus"] = { link = "diffRemoved" }
h["@diff.delta"] = { link = "diffChanged" }

-- Tags (HTML/JSX)
h["@tag"] = { fg = syn.keyword }
h["@tag.attribute"] = { fg = syn.func, italic = true }
h["@tag.delimiter"] = { fg = syn.builtin1 }

-- Language-specific
h["@label.json"] = { fg = syn.func }
h["@constructor.lua"] = { fg = p.fg2 }
h["@variable.member.yaml"] = { fg = syn.func }

-- ── LSP ──────────────────────────────────────────────────────────

h.LspReferenceText = { bg = p.sel0 }
h.LspReferenceRead = { bg = p.sel0 }
h.LspReferenceWrite = { bg = p.sel0 }
h.LspCodeLens = { fg = syn.comment }
h.LspCodeLensSeparator = { fg = p.fg3 }
h.LspSignatureActiveParameter = { fg = p.sel1 }
h.LspInlayHint = { fg = syn.comment, bg = p.bg2 }

-- LSP Semantic Tokens
h["@lsp.type.boolean"] = { link = "@boolean" }
h["@lsp.type.builtinType"] = { link = "@type.builtin" }
h["@lsp.type.comment"] = { link = "@comment" }
h["@lsp.type.enum"] = { link = "@type" }
h["@lsp.type.enumMember"] = { link = "@constant" }
h["@lsp.type.escapeSequence"] = { link = "@string.escape" }
h["@lsp.type.formatSpecifier"] = { link = "@punctuation.special" }
h["@lsp.type.interface"] = { fg = syn.builtin1 }
h["@lsp.type.keyword"] = { link = "@keyword" }
h["@lsp.type.namespace"] = { link = "@module" }
h["@lsp.type.number"] = { link = "@number" }
h["@lsp.type.operator"] = { link = "@operator" }
h["@lsp.type.parameter"] = { link = "@variable.parameter" }
h["@lsp.type.property"] = { link = "@property" }
h["@lsp.type.selfKeyword"] = { link = "@variable.builtin" }
h["@lsp.type.typeAlias"] = { link = "@type" }
h["@lsp.type.unresolvedReference"] = { link = "DiagnosticUnderlineError" }
h["@lsp.type.variable"] = {} -- defer to treesitter
h["@lsp.typemod.function.defaultLibrary"] = { link = "@function.builtin" }
h["@lsp.typemod.variable.defaultLibrary"] = { link = "@variable.builtin" }
h["@lsp.typemod.operator.injected"] = { link = "@operator" }
h["@lsp.typemod.string.injected"] = { link = "@string" }
h["@lsp.typemod.variable.readonly"] = { link = "@constant" }

-- ── Diagnostics ──────────────────────────────────────────────────

h.DiagnosticError = { fg = p.bg1, bg = diag.error }
h.DiagnosticWarn = { fg = p.bg1, bg = diag.warn }
h.DiagnosticInfo = { fg = p.bg1, bg = diag.info }
h.DiagnosticHint = { fg = p.bg1, bg = diag.hint }
h.DiagnosticOk = { fg = diag.ok }

h.DiagnosticVirtualTextError = { link = "DiagnosticError" }
h.DiagnosticVirtualTextWarn = { link = "DiagnosticWarn" }
h.DiagnosticVirtualTextInfo = { link = "DiagnosticInfo" }
h.DiagnosticVirtualTextHint = { link = "DiagnosticHint" }

h.DiagnosticUnderlineError = { sp = diag.error, undercurl = true }
h.DiagnosticUnderlineWarn = { sp = diag.warn, undercurl = true }
h.DiagnosticUnderlineInfo = { sp = diag.info, undercurl = true }
h.DiagnosticUnderlineHint = { sp = diag.hint, undercurl = true }

h.DiagnosticFloatingError = { link = "ErrorMsg" }
h.DiagnosticFloatingWarn = { link = "WarningMsg" }
h.DiagnosticFloatingInfo = { fg = diag.info }
h.DiagnosticFloatingHint = { fg = diag.hint }

h.DiagnosticVirtualLinesError = { link = "DiagnosticFloatingError" }
h.DiagnosticVirtualLinesWarn = { link = "DiagnosticFloatingWarn" }
h.DiagnosticVirtualLinesInfo = { link = "DiagnosticFloatingInfo" }
h.DiagnosticVirtualLinesHint = { link = "DiagnosticFloatingHint" }

h.DiagnosticSignError = { link = "DiagnosticFloatingError" }
h.DiagnosticSignWarn = { link = "DiagnosticFloatingWarn" }
h.DiagnosticSignInfo = { link = "DiagnosticFloatingInfo" }
h.DiagnosticSignHint = { link = "DiagnosticFloatingHint" }

-- ── Diff ─────────────────────────────────────────────────────────

h.DiffAdd = { fg = p.bg1, bg = git.add }
h.DiffChange = { fg = p.bg1, bg = git.changed }
h.DiffDelete = { fg = p.bg1, bg = git.removed }
h.DiffText = { fg = p.bg1, bg = p.yellow }
h.DiffTextAdd = { fg = p.bg1, bg = p.green }

-- ── Treesitter Context ───────────────────────────────────────────

h.TreesitterContextLineNumber = { fg = p.fg0 }

-- ── Plugin: Snacks Notifier ──────────────────────────────────────

h.SnacksNotifierBorderInfo = { fg = diag.info }
h.SnacksNotifierBorderWarn = { fg = diag.warn }
h.SnacksNotifierBorderError = { fg = diag.error }
h.SnacksNotifierBorderDebug = { fg = p.fg1 }
h.SnacksNotifierBorderTrace = { fg = p.fg1 }
h.SnacksNotifierInfo = { fg = diag.info }
h.SnacksNotifierWarn = { fg = diag.warn }
h.SnacksNotifierError = { fg = diag.error }
h.SnacksNotifierDebug = { fg = p.fg1 }
h.SnacksNotifierTrace = { fg = p.fg1 }
h.SnacksNotifierTitleInfo = { fg = diag.info }
h.SnacksNotifierTitleWarn = { fg = diag.warn }
h.SnacksNotifierTitleError = { fg = diag.error }
h.SnacksNotifierTitleDebug = { fg = p.fg1 }
h.SnacksNotifierTitleTrace = { fg = p.fg1 }
h.SnacksNotifierIconInfo = { fg = diag.info }
h.SnacksNotifierIconWarn = { fg = diag.warn }
h.SnacksNotifierIconError = { fg = diag.error }
h.SnacksNotifierIconDebug = { fg = p.fg1 }
h.SnacksNotifierIconTrace = { fg = p.fg1 }

-- ── Plugin: Signify ──────────────────────────────────────────────

h.SignifySignAdd = { fg = git.add }
h.SignifySignChange = { fg = git.changed }
h.SignifySignDelete = { fg = git.removed }

-- ── Plugin: Hop ──────────────────────────────────────────────────

h.HopNextKey = { fg = p.pink, bold = true }
h.HopNextKey1 = { fg = p.cyan, bold = true }
h.HopNextKey2 = { fg = p.blue }
h.HopUnmatched = { fg = syn.comment }

-- ── Plugin: Blink.cmp ────────────────────────────────────────────

h.BlinkCmpDoc = { fg = p.fg1, bg = p.bg0 }
h.BlinkCmpDocBorder = { fg = p.sel0, bg = p.bg0 }
h.BlinkCmpLabel = { fg = p.fg1 }
h.BlinkCmpLabelDeprecated = { fg = syn.dep, strikethrough = true }
h.BlinkCmpLabelMatch = { fg = syn.func }
h.BlinkCmpKindDefault = { fg = p.fg2 }
h.BlinkCmpMenu = { link = "Comment" }
h.BlinkCmpKindKeyword = { link = "Identifier" }
h.BlinkCmpKindVariable = { link = "@variable" }
h.BlinkCmpKindConstant = { link = "@constant" }
h.BlinkCmpKindReference = { link = "Keyword" }
h.BlinkCmpKindValue = { link = "Keyword" }
h.BlinkCmpKindFunction = { link = "Function" }
h.BlinkCmpKindMethod = { link = "Function" }
h.BlinkCmpKindConstructor = { link = "Function" }
h.BlinkCmpKindInterface = { link = "Constant" }
h.BlinkCmpKindEvent = { link = "Constant" }
h.BlinkCmpKindEnum = { link = "Constant" }
h.BlinkCmpKindUnit = { link = "Constant" }
h.BlinkCmpKindClass = { link = "Type" }
h.BlinkCmpKindStruct = { link = "Type" }
h.BlinkCmpKindModule = { link = "@module" }
h.BlinkCmpKindProperty = { link = "@property" }
h.BlinkCmpKindField = { link = "@variable.member" }
h.BlinkCmpKindTypeParameter = { link = "@variable.member" }
h.BlinkCmpKindEnumMember = { link = "@variable.member" }
h.BlinkCmpKindOperator = { link = "Operator" }
h.BlinkCmpKindSnippet = { fg = p.fg2 }

-- ── Custom: Statusline ───────────────────────────────────────────

h.StatusLineActiveItem = { fg = p.black, bg = p.fg1 }
h.StatusLineError = { fg = p.red, bg = p.bg2 }
h.StatusLineWarning = { fg = p.orange, bg = p.bg2 }
h.StatusLineSeparator = { fg = p.black, bg = p.bg2 }

-- ── Custom: Misc ─────────────────────────────────────────────────

h.SnippetTabstopActive = { bg = p.sel0 }
h.OkMsg = { fg = p.green }
h.StderrMsg = { fg = p.red }
h.StdoutMsg = { fg = p.fg1 }

-- ═══════════════════════════════════════════════════════════════════
-- Terminal Colors
-- ═══════════════════════════════════════════════════════════════════

M.terminal_colors = {
    p.black,
    p.red,
    p.green,
    p.yellow,
    p.blue,
    p.magenta,
    p.cyan,
    p.white,
    p.bg4,
    p.red,
    p.green,
    p.yellow,
    p.blue,
    p.magenta,
    p.cyan,
    p.fg0,
}

-- ═══════════════════════════════════════════════════════════════════
-- Apply
-- ═══════════════════════════════════════════════════════════════════

function M.apply()
    vim.cmd.highlight("clear")

    for group, opts in pairs(M.highlights) do
        vim.api.nvim_set_hl(0, group, opts)
    end

    for i, color in ipairs(M.terminal_colors) do
        vim.g["terminal_color_" .. (i - 1)] = color
    end
end

return M
