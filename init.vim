" plugins
" =======

call plug#begin('~/.config/nvim/plugged')

Plug 'nvim-lua/plenary.nvim'
Plug 'benizi/vim-automkdir'
Plug 'christoomey/vim-tmux-navigator'
Plug 'editorconfig/editorconfig-vim'
Plug 'haya14busa/is.vim'
Plug 'hrsh7th/nvim-compe'
Plug 'junegunn/goyo.vim'
Plug 'justinmk/vim-dirvish'
Plug 'kevinhwang91/nvim-hlslens'
Plug 'kyazdani42/nvim-web-devicons'
Plug 'lewis6991/gitsigns.nvim'
Plug 'matze/vim-move'
Plug 'neovim/nvim-lspconfig'
Plug 'nvim-lua/popup.nvim'
Plug 'nvim-telescope/telescope.nvim'
Plug 'nvim-telescope/telescope-fzy-native.nvim'
Plug 'nvim-treesitter/nvim-treesitter', {'do': ':TSUpdate'}
Plug 'norcalli/nvim-colorizer.lua'
Plug 'ntpeters/vim-better-whitespace'
Plug 'phaazon/hop.nvim'
Plug 'rhysd/conflict-marker.vim'
Plug 'sbdchd/neoformat'
Plug 'sodiumjoe/nvim-highlite'
Plug 'tpope/vim-commentary'
Plug 'tpope/vim-eunuch'
Plug 'tpope/vim-fugitive'
Plug 'tpope/vim-repeat'
Plug 'tpope/vim-surround'
Plug 'vimwiki/vimwiki'
Plug 'w0rp/ale'
Plug 'whatyouhide/vim-lengthmatters'

call plug#end()

" general
" =======

" faster startup time
" :h g:python_host_prog
let g:python_host_prog = '/usr/bin/python'
" :h g:python3_host_prog
let g:python3_host_prog = "$HOMEBREW_PREFIX/bin/python3"

scriptencoding utf8
set undofile
set noerrorbells
set splitbelow
set splitright
" enable per-directory .vimrc files
set exrc
" disable unsafe commands in local .vimrc files
set secure
" Insert only one space when joining lines that contain sentence-terminating
" punctuation like `.`.
set nojoinspaces
" send to system clipboard: https://coderwall.com/p/g-d8rg
set clipboard+=unnamed
" don't show intro message
set shortmess=aoOtI
" disable weird scratch window
" set completeopt=preview,menu,noselect
set completeopt=menuone,noselect
" disable extraneous messages
set noshowmode
" always show the cursor position
set ruler
set smartcase
set infercase
set diffopt=filler,vertical
set breakindent
set guicursor=n-v-sm:block,i-c-ci-ve:ver25,r-cr-o:hor20
" don't wrap search result traversal
set nowrapscan

let g:mapleader="\<SPACE>"
" search visual selection
vnoremap // y/<C-R>"<CR>

" copy relative path to clipboard
nmap <silent> <leader>cr :let @+ = expand("%")<cr>
" copy full path to clipboard
nmap <silent> <leader>cf :let @+ = expand("%:p")<cr>

" leader d and leader p for deleting instead of cutting and pasting
nnoremap <leader>d "_d
xnoremap <leader>d "_d
xnoremap <leader>p "_dP

if executable('rg')
  set grepprg=rg\ --vimgrep\ --no-heading\ -S
  set grepformat=%f:%l:%c:%m,%f:%l:%m
endif

set inccommand=split

" restore cursor pos
autocmd BufReadPost *
      \ if line("'\"") > 1 && line("'\"") <= line("$") && &ft !~# 'commit'
      \ |   exe "normal! g`\""
      \ | endif

" movement
" ========

nnoremap j gj
nnoremap k gk

" search
" ======

set ignorecase

" syntax highlighting
" ===================

syntax on
filetype plugin indent on

set nomodeline

" display
" =======

set guifont=Inconsolata:h16
set background=dark
set termguicolors
colorscheme sodium
" folding column width
set foldcolumn=0
" disable tabline
set showtabline=0
set autoindent
set smartindent
set tabstop=2
set shiftwidth=2
set expandtab
" keep buffer of lines above and below cursor
set scrolloff=5
" display incomplete commands
set showcmd

" split dividers and end of buffer character
set fillchars=vert:\│,eob:⌁

" statusline
" ==========

" separator hilight group
hi User1 guifg=#3c4c55 guibg=#556873

function! LinterStatus() abort
  let l:counts = ale#statusline#Count(bufnr(''))

  let l:all_errors = l:counts.error + l:counts.style_error
  let l:all_non_errors = l:counts.total - l:all_errors

  let l:warnings = l:all_non_errors == 0 ? '' : printf('%d⚠', l:all_non_errors)
  let l:errors = l:all_errors == 0 ? '' : printf('%d☒', l:all_errors)

  return join([l:warnings, l:errors], ' ')
endfunction

lua << EOF
function _G.lspStatus()
  local client_names = {}
  for _, client in ipairs(vim.lsp.buf_get_clients()) do
    table.insert(client_names, client.name)
  end
  return table.concat(client_names, ' ')
end
EOF

function! StatusLine() abort

  let l:padding = ' '
  let l:separator=' %1*│%* '

  let l:statusline=''

  " active window
  if g:statusline_winid == win_getid()
    let l:statusline.='%#CursorLine#'
  endif

  " filename
  let l:statusline.=l:padding
  let l:statusline.='%<%{expand("%:~:.")}'
  let l:statusline.=l:padding
  let l:statusline.='%#StatusLine#'
  let l:statusline.=l:padding

  " help/modified/readonly
  let l:statusline.='%(%h%m%r%)'

  " alignment group
  let l:statusline.='%='

  " start error highlight group
  let l:statusline.='%#StatusLineError#'

  " errors from w0rp/ale
  let l:statusline.='%{LinterStatus()}'
  " end error highlight group
  let l:statusline.='%#StatusLine#'

  let l:statusline.=l:separator

  " lsp servers
  let l:statusline.='%{v:lua.lspStatus()}'

  let l:statusline.=l:separator
  " line/total lines
  let l:statusline.='L%l/%L'
  let l:statusline.=l:separator
  " virtual column
  let l:statusline.='C%02v'
  let l:statusline.=l:padding
  return l:statusline
endfunction

set statusline=%!StatusLine()

" javascript source resolution
set path=.
set suffixesadd=.js

function! LoadMainNodeModule(fname)
    let nodeModules = "./node_modules/"
    let packageJsonPath = nodeModules . a:fname . "/package.json"

    if filereadable(packageJsonPath)
        return nodeModules . a:fname . "/" . json_decode(join(readfile(packageJsonPath))).main
    else
        return nodeModules . a:fname
    endif
endfunction

set includeexpr=LoadMainNodeModule(v:fname)

" plugin configs
" ==============

" nvim-treesitter

lua << EOF
require'nvim-treesitter.configs'.setup {
  ensure_installed = "maintained",
  highlight = {
    enable = true,
  },
}
EOF

" nvim-telescope

lua << EOF
require('telescope').setup {
  defaults = {
    prompt_prefix = "❯ ",
    selection_caret = "➤ ",
    vimgrep_arguments = {
      'rg',
      '--vimgrep',
      '--no-heading',
      '--smart-case'
    },
  }
}
require('telescope').load_extension('fzy_native')
EOF

nnoremap <C-p> <cmd>Telescope find_files hidden=true<cr>
" https://github.com/nvim-telescope/telescope.nvim/issues/750
" nnoremap <leader>s <cmd>Telescope buffers show_all_buffers=true sort_lastused=true initial_mode=normal<cr>
nnoremap <leader>s :lua require'telescope.builtin'.buffers{ on_complete = { function() vim.cmd"stopinsert" end } }<cr>
nnoremap <leader>q <cmd>Telescope quickfix<cr><esc>
nnoremap <leader>8 <cmd>Telescope grep_string<cr><esc>
" nnoremap <leader>/ <cmd>Telescope live_grep<cr>
nnoremap <leader>/ :lua require('telescope.builtin').grep_string{ search = vim.fn.input('❯ ' ) }<cr>
nnoremap <leader><Space>/ <cmd>Telescope live_grep cwd=%:h<cr>
nnoremap <leader>d :lua require('telescope.builtin').find_files({search_dirs={'%:h'}})<cr>
nnoremap <leader><C-r> <cmd>Telescope registers<CR>
nnoremap <leader>g <cmd>Telescope git_status<cr><esc>

hi link TelescopeSelection TelescopeNormal

" ale

" cycle through location list
nmap <silent> <leader>n <Plug>(ale_next_wrap)
nmap <silent> <leader>p <Plug>(ale_previous_wrap)

let g:ale_set_balloons = 1
let g:ale_pattern_options_enabled = 1

let g:ale_linters = {
      \   'elixir': [],
      \   'javascript': ['eslint'],
      \   'javascript.jsx': ['eslint'],
      \   'coffeescript': ['jshint'],
      \   'ruby': ['rubocop'],
      \}

let s:rubocop_config = {
\ 'ale_ruby_rubocop_executable': 'scripts/bin/rubocop.rb',
\}

let g:ale_pattern_options = {
\ 'pay-server/.*\.rb$': s:rubocop_config,
\ 'pay-server/.*Gemfile$': s:rubocop_config,
\}

" colorizer-lua

lua << EOF
require'colorizer'.setup()
EOF

" nvim-lspconfig

lua << EOF
local nvim_lsp = require('lspconfig')

-- Use an on_attach function to only map the following keys
-- after the language server attaches to the current buffer
local on_attach = function(client, bufnr)
  local function buf_set_keymap(...) vim.api.nvim_buf_set_keymap(bufnr, ...) end
  local function buf_set_option(...) vim.api.nvim_buf_set_option(bufnr, ...) end

  -- Mappings.
  local opts = { noremap=true, silent=true }

  -- See `:help vim.lsp.*` for documentation on any of the below functions
  buf_set_keymap('n', 'gD', '<Cmd>lua vim.lsp.buf.declaration()<CR>', opts)
  buf_set_keymap('n', 'gd', '<Cmd>lua vim.lsp.buf.definition()<CR>', opts)
  buf_set_keymap('n', 'K', '<Cmd>lua vim.lsp.buf.hover()<CR>', opts)
  buf_set_keymap('n', 'gi', '<cmd>lua vim.lsp.buf.implementation()<CR>', opts)
  buf_set_keymap('n', '<C-k>', '<cmd>lua vim.lsp.buf.signature_help()<CR>', opts)
--  buf_set_keymap('n', '<space>wa', '<cmd>lua vim.lsp.buf.add_workspace_folder()<CR>', opts)
--  buf_set_keymap('n', '<space>wr', '<cmd>lua vim.lsp.buf.remove_workspace_folder()<CR>', opts)
--  buf_set_keymap('n', '<space>wl', '<cmd>lua print(vim.inspect(vim.lsp.buf.list_workspace_folders()))<CR>', opts)
  buf_set_keymap('n', '<space>D', '<cmd>lua vim.lsp.buf.type_definition()<CR>', opts)
  buf_set_keymap('n', '<space>rn', '<cmd>lua vim.lsp.buf.rename()<CR>', opts)
  buf_set_keymap('n', '<space>ca', '<cmd>lua vim.lsp.buf.code_action()<CR>', opts)
  buf_set_keymap('n', 'gr', '<cmd>lua vim.lsp.buf.references()<CR>', opts)
  buf_set_keymap('n', '<space>e', '<cmd>lua vim.lsp.diagnostic.show_line_diagnostics()<CR>', opts)
  buf_set_keymap('n', '[d', '<cmd>lua vim.lsp.diagnostic.goto_prev()<CR>', opts)
  buf_set_keymap('n', ']d', '<cmd>lua vim.lsp.diagnostic.goto_next()<CR>', opts)
  buf_set_keymap('n', '<space>q', '<cmd>lua vim.lsp.diagnostic.set_loclist()<CR>', opts)
  buf_set_keymap("n", "<space>f", "<cmd>lua vim.lsp.buf.formatting()<CR>", opts)

end

-- Use a loop to conveniently call 'setup' on multiple servers and
-- map buffer local keybindings when the language server attaches
local servers = { "flow", "rust_analyzer" }
for _, lsp in ipairs(servers) do
  nvim_lsp[lsp].setup {
    on_attach = on_attach,
    flags = {
      debounce_text_changes = 150,
    }
  }
end
EOF

" nvim-compe

let g:compe = {}
let g:compe.enabled = v:true
let g:compe.autocomplete = v:true
let g:compe.debug = v:false
let g:compe.min_length = 1
let g:compe.preselect = 'enable'
let g:compe.throttle_time = 80
let g:compe.source_timeout = 200
let g:compe.incomplete_delay = 400
let g:compe.max_abbr_width = 100
let g:compe.max_kind_width = 100
let g:compe.max_menu_width = 100
let g:compe.documentation = v:true
let g:compe.source = {}
let g:compe.source.path = v:true
let g:compe.source.buffer = v:true
let g:compe.source.calc = v:true
let g:compe.source.nvim_lsp = v:true
" let g:compe.source.nvim_lua = v:true
" let g:compe.source.vsnip = v:true

" editorconfig

let g:EditorConfig_exclude_patterns = ['fugitive://.*']

" vimwiki

let g:wiki = {}
let g:wiki.path = '~/home/todo.wiki'
let g:wiki.syntax = 'markdown'
let g:work_wiki = {}
let g:work_wiki.path = '~/stripe/todo.wiki'
let g:work_wiki.path_html = '~/stripe/todo.html'
let g:work_wiki.syntax = 'markdown'
let g:vimwiki_auto_header = 1

let g:vimwiki_list = [g:work_wiki, g:wiki]

map <Space>wp <Plug>VimwikiDiaryPrevDay
autocmd FileType vimwiki map <buffer> <leader>wn <Plug>VimwikiDiaryNextDay
map <leader>= <Plug>VimwikiAddHeaderLevel
map <leader>- <Plug>VimwikiRemoveHeaderLevel

" vim-lengthmatters

call lengthmatters#highlight('ctermbg=0 guibg=#556873')
let g:lengthmatters_excluded = [
      \'unite',
      \'tagbar',
      \'startify',
      \'gundo',
      \'vimshell',
      \'w3m',
      \'nerdtree',
      \'help',
      \'qf',
      \'dirvish',
      \'denite',
      \'gitcommit',
      \'json',
      \'vimwiki'
      \]

" vim-move

let g:move_key_modifier = 'C'

" gitsigns

lua << EOF
require('gitsigns').setup()
EOF

" neoformat

augroup fmt
  autocmd!
  autocmd BufWritePre *.{js,rs,go} silent! Neoformat
augroup END

let g:neoformat_enabled_javascript = ['prettier']
let g:neoformat_javascript_prettier = {
      \ 'exe': './node_modules/.bin/prettier',
      \ 'args': ['--stdin', '--stdin-filepath', '"%:p"'],
      \ 'stdin': 1,
      \ }

let g:neoformat_enabled_rust = ['rustfmt']
let g:neoformat_enabled_go = ['goimports', 'gofmt']

" is.vim/nvim-hlslens

lua << EOF
require('hlslens').setup({
    calm_down = true,
    nearest_only = false,
})
EOF

hi default link HlSearchNear Search
hi default link HlSearchLens Search
hi default link HlSearchLensNear IncSearch

set hlsearch
" let g:incsearch#auto_nohlsearch = 1
map n  <Plug>(is-n)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<CR>
map N  <Plug>(is-N)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<CR>
map *  <Plug>(is-*)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<CR>
map #  <Plug>(is-#)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<CR>
map g* <Plug>(is-g*)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<CR>
map g# <Plug>(is-g#)<Plug>(is-nohl-1)<Cmd>lua require('hlslens').start()<CR>

" dirvish

augroup dirvish_config
  autocmd!
  autocmd FileType dirvish silent! unmap <buffer> <C-p>
augroup END

" vim-markdown

let g:vim_markdown_strikethrough = 1
let g:vim_markdown_new_list_item_indent = 2

" goyo

function! s:goyo_enter()
  LengthmattersDisable
  set linebreak
endfunction

function! s:goyo_leave()
  LengthmattersEnable
  set nolinebreak
endfunction

autocmd! User GoyoEnter nested call <SID>goyo_enter()
autocmd! User GoyoLeave nested call <SID>goyo_leave()

" vim-tmux-navigator
"
let g:tmux_navigator_no_mappings = 1

nnoremap <silent> <C-w>h :TmuxNavigateLeft<cr>
nnoremap <silent> <C-w>j :TmuxNavigateDown<cr>
nnoremap <silent> <C-w>k :TmuxNavigateUp<cr>
nnoremap <silent> <C-w>l :TmuxNavigateRight<cr>
nnoremap <silent> <C-w>w :TmuxNavigatePrevious<cr>

" hop

nnoremap <silent> <leader>ew :HopWord<cr>
nnoremap <silent> <leader>e/ :HopPattern<cr>
