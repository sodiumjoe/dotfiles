" plugins
" =======

call plug#begin('~/.vim/plugged')

if has('nvim')
  Plug 'Shougo/denite.nvim'
  Plug 'Shougo/deoplete.nvim', { 'do': ':UpdateRemotePlugins' }
  Plug 'autozimu/LanguageClient-neovim', {
        \ 'branch': 'next',
        \ 'do': 'bash install.sh',
        \ }
endif
Plug 'KeyboardFire/vim-minisnip'
Plug 'airblade/vim-gitgutter'
Plug 'benizi/vim-automkdir'
Plug 'easymotion/vim-easymotion'
Plug 'editorconfig/editorconfig-vim'
Plug 'haya14busa/incsearch-easymotion.vim'
Plug 'haya14busa/incsearch.vim'
Plug 'justinmk/vim-dirvish'
Plug 'matze/vim-move'
Plug 'neoclide/denite-git'
Plug 'ntpeters/vim-better-whitespace'
Plug 'pbrisbin/vim-restore-cursor'
Plug 'sbdchd/neoformat'
Plug 'sheerun/vim-polyglot'
Plug 'tpope/vim-commentary'
Plug 'tpope/vim-eunuch'
Plug 'tpope/vim-fugitive'
Plug 'tpope/vim-repeat'
Plug 'tpope/vim-surround'
Plug 'trevordmiller/nova-vim'
Plug 'vimwiki/vimwiki'
Plug 'w0rp/ale'
Plug 'whatyouhide/vim-lengthmatters'

call plug#end()

" general
" =======

scriptencoding utf8
set backupdir=~/.vim/backups
set directory=~/.vim/swaps
set undofile
set undodir=~/.vim/undo
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
set completeopt-=preview
" disable extraneous messages
set noshowmode
" show the cursor position all the time
set ruler
set smartcase
set infercase
set diffopt=filler,vertical
set breakindent

let g:mapleader="\<SPACE>"
" search visual selection
vnoremap // y/<C-R>"<CR>

" partial command filter on command history
cnoremap <C-k> <Up>
cnoremap <C-j> <Down>

if executable('rg')
  set grepprg=rg\ --vimgrep\ --no-heading\ -S
  set grepformat=%f:%l:%c:%m,%f:%l:%m
endif

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
colorscheme nova
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
set textwidth=80

" split dividers
set fillchars=vert:\│
hi VertSplit guifg=#556873

hi clear IncSearch
hi link IncSearch StatusLine
hi clear Search
hi link Search StatusLine
" get rid of tildes
hi EndOfBuffer guifg=#3C4C55

" statusline
" ==========

hi StatusLine guifg=#7FC1CA guibg=#556873
hi StatusLineNC guifg=#3C4C55 guibg=#556873
hi StatusLineError guifg=#DF8C8C guibg=#556873

function! Git_branch()
  let l:branch = fugitive#head()
  return empty(l:branch)?'':'['.l:branch.']'
endfunction

function! LinterStatus() abort
  let l:counts = ale#statusline#Count(bufnr(''))

  let l:all_errors = l:counts.error + l:counts.style_error
  let l:all_non_errors = l:counts.total - l:all_errors

  return l:counts.total == 0 ? '' : printf(
        \   '%d⚠ %d⨉',
        \   all_non_errors,
        \   all_errors
        \)
endfunction

set statusline=""
set statusline+=%{Git_branch()}
set statusline+=\ "
" filename
set statusline+=%<%f
set statusline+=\ "
" help/modified/readonly
set statusline+=%h%m%r
" alignment group
set statusline+=%=
" start error highlight group
set statusline+=%#StatusLineError#
" errors from w0rp/ale
set statusline+=%{LinterStatus()}
" reset highlight group
set statusline+=%#StatusLine#
set statusline+=\ "
" line/total lines
set statusline+=L%l/%L
set statusline+=\ "
" virtual column
set statusline+=C%02v

" javascript source resolution
set path=.
set suffixesadd=.js,.jsx

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

" easymotion

map <leader>e <Plug>(easymotion-prefix)

" disable shading
let g:EasyMotion_do_shade = 0

" colors
hi EasyMotionTarget ctermfg=1 cterm=bold,underline
hi link EasyMotionTarget2First EasyMotionTarget
hi EasyMotionTarget2Second ctermfg=1 cterm=underline

" vim-static-clojure

" let g:clojure_fuzzy_indent = 0

" denite

if has('nvim')
  " reset 50% winheight on window resize
  augroup deniteresize
    autocmd!
    autocmd VimResized,VimEnter * call denite#custom#option('default',
          \'winheight', winheight(0) / 2)
  augroup end

  call denite#custom#option('default', {
        \ 'prompt': '❯'
        \ })

  call denite#custom#var('file_rec', 'command',
        \ ['rg', '--files', '--glob', '!.git', ''])
  call denite#custom#var('grep', 'command', ['rg'])
  call denite#custom#var('grep', 'default_opts',
        \ ['--hidden', '--vimgrep', '--no-heading', '-S'])
  call denite#custom#var('grep', 'recursive_opts', [])
  call denite#custom#var('grep', 'pattern_opt', ['--regexp'])
  call denite#custom#var('grep', 'separator', ['--'])
  call denite#custom#var('grep', 'final_opts', [])
  call denite#custom#map('insert', '<Esc>', '<denite:enter_mode:normal>',
        \'noremap')
  call denite#custom#map('normal', '<Esc>', '<NOP>',
        \'noremap')
  call denite#custom#map('insert', '<C-v>', '<denite:do_action:vsplit>',
        \'noremap')
  call denite#custom#map('normal', '<C-v>', '<denite:do_action:vsplit>',
        \'noremap')
  call denite#custom#map('normal', 'dw', '<denite:delete_word_after_caret>',
        \'noremap')
endif

nnoremap <C-p> :<C-u>Denite file_rec<CR>
nnoremap <leader>s :<C-u>Denite buffer<CR>
nnoremap <leader><Space>s :<C-u>DeniteBufferDir buffer<CR>
nnoremap <leader>8 :<C-u>DeniteCursorWord grep:. -mode=normal<CR>
nnoremap <leader>/ :<C-u>Denite grep:. -mode=normal<CR>
nnoremap <leader><Space>/ :<C-u>DeniteBufferDir grep:. -mode=normal<CR>
nnoremap <leader>d :<C-u>DeniteBufferDir file_rec<CR>

hi link deniteMatchedChar Special

" denite-extra

nnoremap <leader>o :<C-u>Denite location_list -mode=normal -no-empty<CR>
nnoremap <leader>hs :<C-u>Denite history:search -mode=normal<CR>
nnoremap <leader>hc :<C-u>Denite history:cmd -mode=normal<CR>

" ale

let g:ale_sign_error = '⨉'
let g:ale_sign_warning = '⚠'
let g:ale_statusline_format = ['⨉ %d', '⚠ %d', '']
let g:ale_lint_on_text_changed = 0
let g:ale_lint_on_save = 1
let g:ale_lint_on_enter = 1
" cycle through location list
nmap <silent> <leader>n <Plug>(ale_next_wrap)

let g:ale_linters = {
\   'elixir': [],
\}

let g:ale_rust_cargo_use_check = 1

if has('nvim')
  set inccommand=split
endif

" deoplete

let g:deoplete#enable_at_startup = 1
let g:deoplete#enable_smart_case = 1
let g:deoplete#auto_complete_start_length = 1
let g:deoplete#auto_complete_delay = 50

" editorconfig

let g:EditorConfig_core_mode = 'external_command'
let g:EditorConfig_exclude_patterns = ['fugitive://.*']

" vimwiki

let g:work_wiki = {}
let g:work_wiki.path = '~/work/todo.wiki'
let g:work_wiki.path_html = '~/work/todo.html'

let g:play_wiki = {}
let g:play_wiki.path = '~/play/todo.wiki'
let g:play_wiki.path_html = '~/play/todo.html'

let g:vimwiki_list = [g:work_wiki, g:play_wiki]
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
      \'gitcommit'
      \]

" vim-move

let g:move_key_modifier = 'C'

" vim-better-whitespace

hi link ExtraWhitespace Search

if has('nvim')
  nnoremap <leader>g :<C-u>Denite gitstatus -mode=normal<CR>
  call denite#custom#map('normal', 'a', '<denite:do_action:add>',
        \ 'noremap')
  call denite#custom#map('normal', 'd', '<denite:do_action:delete>',
        \ 'noremap')
  call denite#custom#map('normal', 'r', '<denite:do_action:reset>',
        \ 'noremap')
endif

" vim-gitgutter

set signcolumn=yes

" neoformat

autocmd BufWritePre *.js Neoformat
autocmd BufWritePre *.jsx Neoformat
autocmd BufWritePre *.rs Neoformat

let g:neoformat_enabled_javascript = ['prettier']
let g:neoformat_javascript_prettier = {
      \ 'exe': './node_modules/.bin/prettier',
      \ 'args': ['--write', '--config .prettierrc'],
      \ 'replace': 1
      \ }
let g:neoformat_javascript_prettier2 = {
      \ 'exe': './node_modules/.bin/prettier',
      \ 'args': ['--write', '--config prettier.config.js'],
      \ 'replace': 1
      \ }

let g:neoformat_rust_rustfmt = {
      \ 'exe': 'rustup',
      \ 'args': ['run', 'nightly', 'rustfmt'],
      \ 'stdin': 1,
      \ }

let g:neoformat_enabled_rust = ['rustfmt']


" incsearch

" map /  <Plug>(incsearch-forward)
" map ?  <Plug>(incsearch-backward)
" map g/ <Plug>(incsearch-stay)

set hlsearch
let g:incsearch#auto_nohlsearch = 1
map n  <Plug>(incsearch-nohl-n)
map N  <Plug>(incsearch-nohl-N)
map *  <Plug>(incsearch-nohl-*)
map #  <Plug>(incsearch-nohl-#)
map g* <Plug>(incsearch-nohl-g*)
map g# <Plug>(incsearch-nohl-g#)

" incsearch-easymotion

map / <Plug>(incsearch-easymotion-/)
map ? <Plug>(incsearch-easymotion-?)
map g/ <Plug>(incsearch-easymotion-stay)

" dirvish

augroup dirvish_config
  autocmd!
  autocmd FileType dirvish silent! unmap <buffer> <C-p>
augroup END

augroup dirvish_fugitive
  autocmd!
  autocmd FileType dirvish call fugitive#detect(@%)
augroup end

" LanguageClient-neovim

let g:LanguageClient_serverCommands = {
      \ 'rust': ['rls'],
      \ 'javascript': ['flow', 'lsp', '--from', './node_modules/.bin'],
      \ 'javascript.jsx': ['flow', 'lsp', '--from', './node_modules/.bin'],
      \}

let g:LanguageClient_autoStart = 1

nnoremap <silent> K :call LanguageClient#textDocument_hover()<CR>
nnoremap <silent> gd :call LanguageClient#textDocument_definition()<CR>

let g:LanguageClient_loggingFile = '/tmp/LanguageClient.log'
let g:LanguageClient_loggingLevel = 'INFO'
let g:LanguageClient_serverStderr = '/tmp/LanguageServer.log'
let g:LanguageClient_rootMarkers = ['.flowconfig']

set diffopt+=iwhite
set diffexpr=""
