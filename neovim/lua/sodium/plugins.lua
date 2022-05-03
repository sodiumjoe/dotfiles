local utils = require("sodium.utils")
local g = vim.g

-- vim-plug
-- ========
vim.fn["plug#begin"]("~/.config/nvim/plugged")

vim.fn["plug#"]("nvim-lua/plenary.nvim")
vim.fn["plug#"]("benizi/vim-automkdir")
vim.fn["plug#"]("christoomey/vim-tmux-navigator")
vim.fn["plug#"]("editorconfig/editorconfig-vim")
vim.fn["plug#"]("folke/trouble.nvim")
vim.fn["plug#"]("haya14busa/is.vim")
vim.fn["plug#"]("hrsh7th/cmp-nvim-lsp")
vim.fn["plug#"]("hrsh7th/cmp-buffer")
vim.fn["plug#"]("hrsh7th/cmp-path")
vim.fn["plug#"]("hrsh7th/nvim-cmp")
vim.fn["plug#"]("hrsh7th/vim-vsnip")
vim.fn["plug#"]("jose-elias-alvarez/null-ls.nvim")
vim.fn["plug#"]("junegunn/goyo.vim")
vim.fn["plug#"]("justinmk/vim-dirvish")
vim.fn["plug#"]("kevinhwang91/nvim-hlslens")
vim.fn["plug#"]("kyazdani42/nvim-web-devicons")
vim.fn["plug#"]("matze/vim-move")
vim.fn["plug#"]("mhinz/vim-signify")
vim.fn["plug#"]("neovim/nvim-lspconfig")
vim.fn["plug#"]("nvim-lua/lsp-status.nvim")
vim.fn["plug#"]("nvim-lua/popup.nvim")
vim.fn["plug#"]("nvim-telescope/telescope.nvim")
vim.fn["plug#"]("nvim-telescope/telescope-fzf-native.nvim", { ["do"] = "make" })
vim.fn["plug#"]("nvim-treesitter/nvim-treesitter", { branch = "0.5-compat", ["do"] = ":TSUpdate" })
vim.fn["plug#"]("ikatyang/tree-sitter-markdown")
vim.fn["plug#"]("norcalli/nvim-colorizer.lua")
vim.fn["plug#"]("onsails/lspkind-nvim")
vim.fn["plug#"]("ntpeters/vim-better-whitespace")
vim.fn["plug#"]("phaazon/hop.nvim")
vim.fn["plug#"]("rhysd/conflict-marker.vim")
vim.fn["plug#"]("sodiumjoe/nvim-highlite")
vim.fn["plug#"]("tpope/vim-commentary")
vim.fn["plug#"]("tpope/vim-eunuch")
vim.fn["plug#"]("tpope/vim-fugitive")
vim.fn["plug#"]("tpope/vim-repeat")
vim.fn["plug#"]("tpope/vim-surround")
vim.fn["plug#"]("vimwiki/vimwiki")
vim.fn["plug#"]("whatyouhide/vim-lengthmatters")

vim.fn["plug#end"]()

g.popup_opts = {
  focusable = false,
  border = "rounded",
}

-- colorizer
-- =========
require("colorizer").setup()

-- signify
-- =======
g.signify_sign_add = "│"
g.signify_sign_change = "│"
g.signify_sign_change_delete = "_│"
g.signify_sign_show_count = 0

-- cmp
-- ===
local cmp = require("cmp")
cmp.setup({
  window = {
    documentation = g.popup_opts,
  },
  view = {
    entries = { name = "custom", selection_order = "near_cursor" },
  },
  mapping = cmp.mapping.preset.insert({
    ["<C-n>"] = function(fallback)
      if cmp.visible() then
        cmp.select_next_item()
      else
        fallback()
      end
    end,
    ["<C-p>"] = function(fallback)
      if cmp.visible() then
        cmp.select_prev_item()
      else
        fallback()
      end
    end,
  }),
  sources = cmp.config.sources({
    {
      name = "buffer",
      option = {
        -- completion candidates from all open buffers
        get_bufnrs = function()
          local bufs = {}
          for _, win in ipairs(vim.api.nvim_list_wins()) do
            local buf_num = vim.api.nvim_win_get_buf(win)
            local ft = vim.api.nvim_buf_get_option(buf_num, "filetype")
            -- don't complete from json and graphql buffers
            if ft ~= "json" and ft ~= "graphql" then
              bufs[buf_num] = true
            end
          end
          return vim.tbl_keys(bufs)
        end,
      },
    },
    { name = "nvim_lsp" },
    { name = "path" },
  }),
  snippet = {
    expand = function(args)
      vim.fn["vsnip#anonymous"](args.body)
    end,
  },
  formatting = {
    format = require("lspkind").cmp_format({
      menu = {
        buffer = "[Buffer]",
        nvim_lsp = "[LSP]",
      },
    }),
  },
})

-- nvim-web-devicons
-- =================
require("nvim-web-devicons").setup({
  default = true,
})

-- dirvish
-- =======
local dirvish_autocmd = utils.augroup("DirvishConfig", { clear = true })
dirvish_autocmd("FileType", {
  pattern = { "dirvish" },
  command = "silent! unmap <buffer> <C-p>",
})
dirvish_autocmd("FileType", {
  pattern = { "dirvish" },
  command = "silent! unmap <buffer> <C-n>",
})

-- editorconfig
-- ============
g.EditorConfig_exclude_patterns = { "fugitive://.*" }

-- hlslens
-- =======
require("hlslens").setup({
  calm_down = true,
  nearest_only = false,
})

vim.o.hlsearch = true

utils.map({
  { "n", "n", "<Plug>(is-n)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<cr>" },
  { "n", "N", "<Plug>(is-N)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<cr>" },
  { "n", "*", "<Plug>(is-*)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<cr>" },
  { "n", "#", "<Plug>(is-#)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<cr>" },
  { "n", "g*", "<Plug>(is-g*)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<cr>" },
  { "n", "g#", "<Plug>(is-g#)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<cr>" },
})

-- hop
-- ===
require("hop").setup({ create_hl_autocmd = false })
vim.api.nvim_command([[hi clear HopUnmatched]])

utils.map({
  {
    "n",
    "<leader>ew",
    "",
    {
      callback = require("hop").hint_words,
    },
  },
  { "n", "<leader>e/", "", {
    callback = require("hop").hint_patterns,
  } },
})

-- vim-lengthmatters
-- =================
vim.cmd("call lengthmatters#highlight('ctermbg=0 guibg=#556873')")
g.lengthmatters_excluded = {
  "tagbar",
  "startify",
  "gundo",
  "vimshell",
  "w3m",
  "nerdtree",
  "help",
  "qf",
  "dirvish",
  "gitcommit",
  "json",
  "vimwiki",
  "javascript",
  "javascript.jsx",
  "lua",
}

-- null-ls
-- =======
local null_ls = require("null-ls")

-- in lua, `0` evaluates as truthy
local function is_executable(bin)
  return vim.fn.executable(bin) > 0
end

local sources = {
  null_ls.builtins.diagnostics.eslint_d.with({
    condition = function()
      return is_executable("eslint_d")
    end,
    cwd = function(params)
      return require("lspconfig/util").root_pattern(".eslintrc.js")(params.bufname)
    end,
  }),
  null_ls.builtins.diagnostics.eslint.with({
    condition = function()
      return is_executable("eslint") and not is_executable("eslint_d")
    end,
    prefer_local = true,
  }),
  null_ls.builtins.diagnostics.rubocop.with({
    condition = function()
      return is_executable("scripts/bin/rubocop-daemon/rubocop")
    end,
    command = "scripts/bin/rubocop-daemon/rubocop",
  }),
  null_ls.builtins.formatting.eslint_d.with({
    condition = function()
      return is_executable("eslint_d")
    end,
    cwd = function(params)
      return require("lspconfig/util").root_pattern(".eslintrc.js")(params.bufname)
    end,
  }),
  null_ls.builtins.formatting.eslint.with({
    condition = function()
      return is_executable("eslint") and not is_executable("eslint_d")
    end,
    prefer_local = true,
  }),
  null_ls.builtins.formatting.rustfmt,
}

null_ls.setup({
  sources = sources,
  on_attach = function(client)
    if client.resolved_capabilities.document_formatting then
      utils.augroup("LspFormatting", { clear = true })("BufWritePre", {
        pattern = { "<buffer>" },
        callback = vim.lsp.buf.formatting_sync,
      })
    end
  end,
})

-- lspconfig
-- =========
local nvim_lsp = require("lspconfig")
local lsp_status = require("lsp-status")

vim.diagnostic.config({
  signs = { priority = 11 },
  virtual_text = false,
  update_in_insert = false,
  float = {
    focusable = g.popup_opts.focusable,
    border = g.popup_opts.border,
    format = function(diagnostic)
      local str = string.format("[%s] %s", diagnostic.source, diagnostic.message)
      if diagnostic.code then
        str = str .. " (" .. diagnostic.code .. ")"
      end
      return str
    end,
  },
})

for type, icon in pairs(utils.icons) do
  local hl = "DiagnosticSign" .. type
  vim.fn.sign_define(hl, { text = icon, texthl = hl, numhl = "" })
end

vim.lsp.handlers["textDocument/hover"] = vim.lsp.with(vim.lsp.handlers.hover, g.popup_opts)
vim.lsp.handlers["textDocument/signatureHelp"] = vim.lsp.with(vim.lsp.handlers.signature_help, g.popup_opts)

local on_attach = function(client, bufnr)
  if client.resolved_capabilities.document_formatting then
    utils.augroup("LspFormatting", { clear = true })("BufWritePre", {
      pattern = { "<buffer>" },
      callback = vim.lsp.buf.formatting_sync,
    })
  end
  lsp_status.on_attach(client, bufnr)
  require("lspkind").init({})
end

local servers = {
  rust_analyzer = {},
  tsserver = {
    cmd_env = { NODE_OPTIONS = "--max-old-space-size=8192" },
    on_attach = function(client, bufnr)
      client.resolved_capabilities.document_formatting = false
      on_attach(client, bufnr)
    end,
    init_options = {
      maxTsServerMemory = "8192",
    },
    filetypes = { "typescript", "typescriptreact", "typescript.tsx" },
  },
  sorbet = {
    cmd = { "pay", "exec", "scripts/bin/typecheck", "--lsp" },
  },
  flow = {},
  sumneko_lua = {},
}

for lsp, options in pairs(servers) do
  local defaults = {
    on_attach = on_attach,
    flags = {
      debounce_text_changes = 150,
    },
    capabilities = lsp_status.capabilities,
  }

  local setup_options = vim.tbl_extend("force", defaults, options)

  nvim_lsp[lsp].setup(setup_options)
end

-- See `:help vim.lsp.*` for documentation on any of the below functions
utils.map({
  { "n", "gD", "", { callback = vim.lsp.buf.declaration } },
  { "n", "gd", "", { callback = vim.lsp.buf.definition } },
  { "n", "K", "", { callback = vim.lsp.buf.hover } },
  { "n", "gi", "", { callback = vim.lsp.buf.implementation } },
  { "n", "<space>D", "", { callback = vim.lsp.buf.type_definition } },
  -- { "n", "<space>rn", "<cmd>lua vim.lsp.buf.rename()<cr>", opts },
  { "n", "<space>ca", "", { callback = vim.lsp.buf.code_action } },
  { "n", "gr", "", { callback = vim.lsp.buf.references } },
  { "n", "<space>ee", "", { callback = vim.lsp.diagnostic.show_line_diagnostics } },
  { "n", "<leader>p", "", { callback = vim.diagnostic.goto_prev } },
  { "n", "<leader>n", "", { callback = vim.diagnostic.goto_next } },
  {
    "n",
    "<space>q",
    "",
    {
      callback = function()
        vim.diagnostic.setqflist({ open = false })
        require("telescope.builtin").quickfix({ initial_mode = "normal" })
      end,
    },
  },
  { "n", "<space>f", "", { callback = vim.lsp.buf.formatting } },
})

-- telescope
-- =========
local telescope = require("telescope")
telescope.setup({
  defaults = {
    selection_caret = "  ",
    vimgrep_arguments = {
      "rg",
      "--vimgrep",
      "--no-heading",
      "--smart-case",
    },
  },
})

telescope.load_extension("fzf")

utils.map({
  {
    "n",
    [[<leader>r]],
    "",
    {
      callback = function()
        require("telescope.builtin").resume({ initial_mode = "normal" })
      end,
    },
  },
  {
    "n",
    [[<C-p>]],
    "",
    {
      callback = function()
        require("telescope.builtin").find_files({ hidden = true })
      end,
    },
  },
  {
    "n",
    [[<leader>s]],
    "",
    {
      callback = function()
        require("telescope.builtin").buffers({
          show_all_buffers = true,
          sort_mru = true,
          ignore_current_buffer = true,
          initial_mode = "normal",
        })
      end,
    },
  },
  { "n", [[<leader>8]], "", {
    callback = require("telescope.builtin").grep_string,
  } },
  {
    "n",
    [[<leader>/]],
    "",
    {
      callback = require("telescope.builtin").live_grep,
    },
  },
  {
    "n",
    [[<leader><Space>/]],
    "",
    {
      callback = function()
        require("telescope.builtin").live_grep({ cwd = vim.fn.expand("%:h") })
      end,
    },
  },
  -- { "n", [[<leader>d]], [[:lua require('telescope.builtin').find_files({search_dirs={'%:h'}})<cr>]] },
  {
    "n",
    [[<leader>d]],
    "",
    {
      callback = function()
        require("telescope.builtin").find_files({ search_dirs = vim.fn.expand("%:h") })
      end,
    },
  },
  { "n", [[<leader><C-r>]], "", { callback = require("telescope.builtin").registers } },
  {
    "n",
    [[<leader>g]],
    "",
    {
      callback = function()
        require("telescope.builtin").git_status({ use_git_root = false })
      end,
    },
  },
})

-- vim-tmux-navigator
-- ==================
g.tmux_navigator_no_mappings = 1

utils.map({
  { "n", "<C-w>h", ":TmuxNavigateLeft<cr>" },
  { "n", "<C-w>j", ":TmuxNavigateDown<cr>" },
  { "n", "<C-w>k", ":TmuxNavigateUp<cr>" },
  { "n", "<C-w>l", ":TmuxNavigateRight<cr>" },
  { "n", "<C-w>w", ":TmuxNavigatePrevious<cr>" },
})

-- nvim-treesitter
-- ===============
require("nvim-treesitter.configs").setup({
  ensure_installed = "maintained",
  -- https://github.com/nvim-treesitter/nvim-treesitter/issues/1313
  ignore_install = { "comment", "jsdoc" },
  highlight = {
    enable = true,
    disable = {},
  },
})

-- vim-better-whitespace
-- =====================

utils.augroup("DisableBetterWhitespace", { clear = true })("Filetype", {
  pattern = { "diff", "gitcommit", "qf", "help", "markdown", "javascript" },
  command = "DisableWhitespace",
})

-- vim-move
-- ========
g.move_key_modifier = "C"

-- vimwiki
-- =======
local wiki = {
  path = "~/home/todo.wiki",
  syntax = "markdown",
}
local work_wiki = {
  path = "~/stripe/todo.wiki",
  path_html = "~/stripe/todo.html",
  syntax = "markdown",
}

if vim.fn.isdirectory(vim.fn.expand("~/stripe")) ~= 0 then
  g.vimwiki_list = { work_wiki, wiki }
else
  g.vimwiki_list = { wiki }
end
g.vimwiki_auto_header = 1

utils.map({
  { "n", "<leader>wp", "<Plug>VimwikiDiaryPrevDay" },
  { "n", "<leader>=", "<Plug>VimwikiAddHeaderLevel" },
  { "n", "<leader>-", "<Plug>VimwikiRemoveHeaderLevel" },
})

local vimwiki_autocmd = utils.augroup("Vimwiki", { clear = true })

vimwiki_autocmd("FileType", {
  pattern = { "vimwiki" },
  command = "nmap <buffer> <leader>wn <Plug>VimwikiDiaryNextDay",
})
vimwiki_autocmd("FileType", {
  pattern = { "vimwiki" },
  callback = function()
    require("cmp").setup.buffer({ enabled = false })
  end,
})

-- tree-sitter-markdown
-- ====================
local parser_config = require("nvim-treesitter.parsers").get_parser_configs()
parser_config.markdown = {
  install_info = {
    url = "https://github.com/ikatyang/tree-sitter-markdown",
    files = { "src/parser.c", "src/scanner.cc" },
  },
  filetype = "markdown",
  used_by = "vimwiki",
}
parser_config.markdown.used_by = "vimwiki"

-- goyo
-- ====

vim.cmd([[
  function! s:goyo_enter()
    set linebreak
  endfunction

  function! s:goyo_leave()
    set nolinebreak
  endfunction

  autocmd! User GoyoEnter nested call <SID>goyo_enter()
  autocmd! User GoyoLeave nested call <SID>goyo_leave()
]])
