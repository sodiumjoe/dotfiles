" plugins
" =======

call plug#begin('~/.config/nvim/plugged')

Plug 'nvim-lua/plenary.nvim'
" Plug 'Shougo/denite.nvim'
" Plug 'Shougo/deoplete.nvim', { 'do': ':UpdateRemotePlugins' }
" Plug 'Shougo/neoyank.vim'
" Plug 'airblade/vim-gitgutter'
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
Plug 'lifepillar/vim-colortemplate'
" Plug 'liuchengxu/vim-clap', { 'do': ':Clap install-binary' }
Plug 'matze/vim-move'
" Plug 'ncm2/float-preview.nvim'
" Plug 'neoclide/denite-git'
Plug 'nvim-lua/popup.nvim'
Plug 'nvim-telescope/telescope.nvim'
Plug 'nvim-telescope/telescope-fzy-native.nvim'
Plug 'nvim-treesitter/nvim-treesitter', {'do': ':TSUpdate'}
Plug 'norcalli/nvim-colorizer.lua'
Plug 'ntpeters/vim-better-whitespace'
Plug 'phaazon/hop.nvim'
Plug 'rhysd/conflict-marker.vim'
Plug 'sbdchd/neoformat'
" Plug 'sheerun/vim-polyglot'
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

let g:mapleader="\<SPACE>"
" search visual selection
vnoremap // y/<C-R>"<CR>

" move line up
cnoremap <C-k> <Up>
" move line down
cnoremap <C-j> <Down>
" copy relative path to clipboard
nmap <silent> <leader>cr :let @+ = expand("%")<cr>
" copy full path to clipboard
nmap <silent> <leader>cf :let @+ = expand("%:p")<cr>

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

" Telescope

lua << EOF
require('telescope').setup{
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
nnoremap <leader>s <cmd>Telescope buffers show_all_buffers=true sort_lastused=true initial_mode=normal<cr>
nnoremap <leader>q <cmd>Telescope quickfix<cr><esc>
nnoremap <leader>8 <cmd>Telescope grep_string<cr><esc>
nnoremap <leader>/ <cmd>Telescope live_grep<cr>
nnoremap <leader><Space>/ <cmd>Telescope live_grep cwd=%:h<cr>
nnoremap <leader>d :lua require('telescope.builtin').find_files({search_dirs={'%:h'}})<cr>
" nnoremap <leader>r :<C-u>Denite -resume -cursor-pos=+1<CR>
nnoremap <leader><C-r> <cmd>Telescope registers<CR>
nnoremap <leader>g <cmd>Telescope git_status<cr><esc>

hi link TelescopeSelection TelescopeNormal

" denite

" call denite#custom#option('_', {
"       \ 'prompt': '❯',
"       \ 'split': 'floating',
"       \ 'highlight_matched_char': 'Underlined',
"       \ 'highlight_matched_range': 'NormalFloat',
"       \ 'wincol': &columns / 6,
"       \ 'winwidth': &columns * 2 / 3,
"       \ 'winrow': &lines / 6,
"       \ 'winheight': &lines * 2 / 3,
"       \ 'max_dynamic_update_candidates': 100000
"       \ })

" call denite#custom#var('file/rec', 'command',
"       \ ['fd', '-H', '--full-path'])
" call denite#custom#source(
"     	\ 'file/rec', 'matchers', ['matcher/clap'])
" call denite#custom#filter('matcher/clap',
"       \ 'clap_path', expand('~/.config/nvim/plugged/vim-clap'))
" call denite#custom#var('grep', 'command', ['rg'])
" call denite#custom#var('grep', 'default_opts',
"       \ ['--vimgrep', '--smart-case', '--no-heading'])
" call denite#custom#var('grep', 'recursive_opts', [])
" call denite#custom#var('grep', 'pattern_opt', ['--regexp'])
" call denite#custom#var('grep', 'separator', ['--'])
" call denite#custom#var('grep', 'final_opts', [])

" autocmd FileType denite call s:denite_settings()

" function! s:denite_settings() abort
"   nnoremap <silent><buffer><expr> <CR>
"         \ denite#do_map('do_action')
"   nnoremap <silent><buffer><expr> <C-v>
"         \ denite#do_map('do_action', 'vsplit')
"   nnoremap <silent><buffer><expr> d
"         \ denite#do_map('do_action', 'delete')
"   nnoremap <silent><buffer><expr> p
"         \ denite#do_map('do_action', 'preview')
"   nnoremap <silent><buffer><expr> <Esc>
"         \ denite#do_map('quit')
"   nnoremap <silent><buffer><expr> q
"         \ denite#do_map('quit')
"   nnoremap <silent><buffer><expr> i
"         \ denite#do_map('open_filter_buffer')
" endfunction

" autocmd FileType denite-filter call s:denite_filter_settings()

" function! s:denite_filter_settings() abort
"   nmap <silent><buffer> <Esc> <Plug>(denite_filter_quit)
" endfunction

" nnoremap <C-p> :<C-u>Denite file/rec -start-filter<CR>
" nnoremap <leader>s :<C-u>Denite buffer<CR>
" nnoremap <leader>8 :<C-u>DeniteCursorWord grep:.<CR>
" nnoremap <leader>/ :<C-u>Denite -start-filter -filter-updatetime=0 grep:::!<CR>
" nnoremap <leader><Space>/ :<C-u>DeniteBufferDir -start-filter -filter-updatetime=0 grep:::!<CR>
" nnoremap <leader>d :<C-u>DeniteBufferDir file/rec -start-filter<CR>
" nnoremap <leader>r :<C-u>Denite -resume -cursor-pos=+1<CR>
" nnoremap <leader><C-r> :<C-u>Denite register:.<CR>
" nnoremap <leader>g :<C-u>Denite gitstatus<CR>

" neoyank

nnoremap <leader>y :<C-u>Denite neoyank<CR>

" ale

" cycle through location list
nmap <silent> <leader>n <Plug>(ale_next_wrap)
nmap <silent> <leader>p <Plug>(ale_previous_wrap)

let g:ale_set_balloons = 1
let g:ale_pattern_options_enabled = 1

call ale#linter#Define('ruby', {
\   'name': 'sorbet-payserver',
\   'lsp': 'stdio',
\   'executable': 'true',
\   'command': 'pay exec scripts/bin/typecheck --lsp',
\   'language': 'ruby',
\   'project_root': $HOME . '/stripe/pay-server',
\})

let g:ale_linters = {
      \   'elixir': [],
      \   'javascript': ['eslint', 'flow', 'flow-language-server'],
      \   'javascript.jsx': ['eslint', 'flow', 'flow-language-server'],
      \   'coffeescript': ['jshint'],
      \   'ruby': ['rubocop', 'sorbet-payserver'],
      \   'rust': ['cargo', 'rls'],
      \}

let s:rubocop_config = {
\ 'ale_ruby_rubocop_executable': 'bundle',
\}

let g:ale_pattern_options = {
\ 'pay-server/.*\.rb$': s:rubocop_config,
\ 'pay-server/.*Gemfile$': s:rubocop_config,
\}

" https://github.com/w0rp/ale/issues/2560#issuecomment-500166527
let g:ale_linters_ignore = {
      \   'javascript': ['flow-language-server'],
      \   'javascript.jsx': ['flow-language-server'],
      \}

let g:ale_rust_cargo_use_check = 1

nnoremap <silent> K :ALEHover<CR>
nnoremap <silent> <leader>k :ALEDetail<CR>
nnoremap <silent> gd :ALEGoToDefinition<CR>
nnoremap <silent> gvd :ALEGoToDefinitionInVSplit<CR>
nnoremap <silent> gr :ALEFindReferences -relative<CR>

" colorizer-lua

lua << EOF
require'colorizer'.setup()
EOF

" deoplete

" let g:deoplete#enable_at_startup = 1

" call deoplete#custom#option({
"       \   'min_pattern_length': 1,
"       \   'auto_complete_delay': 50,
"       \})

" " disable deoplete for denite buffer
" autocmd FileType denite-filter
"       \   call deoplete#custom#buffer_option('auto_complete', v:false)

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
" let g:compe.source.nvim_lsp = v:true
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
map <leader>wp <Plug>VimwikiDiaryPrevDay
map <leader>wn <Plug>VimwikiDiaryNextDay

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

" vim-gitgutter

set signcolumn=yes

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

" float-preview

" let g:float_preview#docked = 1

" hop

nnoremap <silent> <leader>ew :HopWord<cr>
nnoremap <silent> <leader>e/ :HopPattern<cr>
