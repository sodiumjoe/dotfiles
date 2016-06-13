" LEGACY VIM
" ==========

if !has('nvim')

  set nocompatible                                                                " vim settings, rather than vi settings
                                                                                  " must be first, because it changes other options as a side effect
  set enc=utf-8
  set history=50                                                                  " keep 50 lines of command line history
  set laststatus=2
  set backspace=indent,eol,start                                                  " allow backspacing over everything in insert mode
  set incsearch                                                                   " incremental searching
  set hlsearch                                                                    " highlight last used search pattern
  set timeoutlen=1000 ttimeoutlen=10

endif

" PLUGINS
" =======

call plug#begin('~/.vim/plugged')

Plug 'airblade/vim-gitgutter'
Plug 'altercation/vim-colors-solarized'
Plug 'benekastah/neomake'
Plug 'benjie/neomake-local-eslint.vim'
Plug 'digitaltoad/vim-jade'
Plug 'editorconfig/editorconfig-vim'
Plug 'gavocanov/vim-js-indent'
" Plug 'guns/vim-clojure-static'
Plug 'Lokaltog/vim-easymotion'
Plug 'mxw/vim-jsx'
Plug 'ntpeters/vim-better-whitespace'
Plug 'othree/yajs.vim'
Plug 'pbrisbin/vim-restore-cursor'
" Plug 'rust-lang/rust.vim'
if has('nvim')
  Plug 'Shougo/deoplete.nvim'
else
  Plug 'Shougo/neocomplete.vim'
endif
Plug 'Shougo/neoyank.vim'
Plug 'Shougo/vimproc.vim', { 'do': 'make' }
Plug 'Shougo/unite.vim'
Plug 'scrooloose/nerdtree'
Plug 'tpope/vim-commentary'
Plug 'tpope/vim-fireplace'
Plug 'tpope/vim-fugitive'
Plug 'tpope/vim-markdown'
Plug 'tpope/vim-repeat'
Plug 'tpope/vim-surround'

call plug#end()

" GENERAL
" =======

set backupdir=~/.vim/backups
set directory=~/.vim/swaps
set undofile
set undodir=~/.vim/undo
set noerrorbells
set splitbelow
set splitright

set exrc                                                                        " enable per-directory .vimrc files
set secure                                                                      " disable unsafe commands in local .vimrc files
set nojoinspaces                                                                " Insert only one space when joining lines that contain sentence-terminating
                                                                                " punctuation like `.`.
set clipboard+=unnamed                                                          " send to system clipboard: https://coderwall.com/p/g-d8rg
set shortmess=aoOtI                                                             " don't show intro message
set completeopt-=preview                                                        " disable weird scratch window
set noshowmode                                                                  " disable extraneous messages
set ruler                                                                       " show the cursor position all the time
set smartcase

map <space> <leader>
nmap <leader>p :set paste!<Cr>

" MOVEMENT
" ========

nmap j gj
nmap k gk

au BufReadPost *                                                                " jump to the last known cursor position
  \ if line("'\"") > 1 && line("'\"") <= line("$") |                            " except when position is invalid or inside an event handler
  \   exe "normal! g`\"" |                                                      " (happens when dropping a file on gvim).
  \ endif                                                                       " Also don't do it when the mark is in the first line, that is the default

" AUTORELOAD VIMRC
" ===============

augroup reload_vimrc " {
  autocmd!
  autocmd BufWritePost $MYVIMRC source $MYVIMRC
augroup END " }

" SEARCH
" ======

set showcmd                                                                     " display incomplete commands
set ignorecase
nnoremap <leader>n :<C-u>noh<CR>

" SYNTAX HIGHLIGHTING
" ===================

syntax on                                                                       " syntax highlighting
filetype plugin indent on                                                       " Enable file type detection.

au BufRead,BufNewFile *.pjs setfiletype javascript

set modelines=0
set nomodeline

autocmd BufRead,BufNewFile ~/work/* setlocal noexpandtab

" DISPLAY
" =======

set guifont=Inconsolata:h16
set background=dark
let g:solarized_termtrans = 1
colorscheme solarized
set guioptions-=T
set guioptions-=m                                                               " remove menu bar
set nu
set fdc=2                                                                       " folding column
set showtabline=1                                                               " hide when only one tab
set smarttab
set autoindent
set smartindent
set ts=2
set sw=2
set expandtab
set scrolloff=5                                                                 " keep buffer of 10 lines above and below cursor

hi! VertSplit ctermfg=Black                                                     " split border color
hi! StatusLine ctermfg=LightGray                                                " status line color
hi! StatusLineNC ctermfg=Black                                                  " inactive status line color
hi! Folded cterm=bold ctermbg=8                                                 " fold line style

set fillchars+=vert:\ 
highlight ExtraWhitespace ctermbg=darkred

" let &colorcolumn=join(range(81,999),",")                                        " highlight after 80 characters

" PLUGIN CONFIGS
" ==============

" EASYMOTION

let g:EasyMotion_do_mapping = 0                                                 " disable default mappings
let g:EasyMotion_do_shade = 0                                                   " disable shading
nmap <leader>w <Plug>(easymotion-bd-w)
hi link EasyMotionTarget ErrorMsg
hi link EasyMotionTarget2First ErrorMsg
hi link EasyMotionTarget2Second ErrorMsg

" VIM-STATIC-CLOJURE

let g:clojure_fuzzy_indent = 0

" UNITE

let g:unite_source_history_yank_enable = 1
call unite#filters#matcher_default#use(['matcher_fuzzy'])
call unite#custom#source('file_rec/async', 'ignore_pattern', 'node_modules/\|bower_components/\|.git/\|.bundle/\|\.vagrant/|.bin/')
nnoremap <C-p> :<C-u>Unite -start-insert buffer file_rec/async<CR>
nnoremap <leader>y :<C-u>Unite history/yank<CR>
nnoremap <leader>s :<C-u>Unite -start-insert buffer<CR>
nnoremap <leader>8 :<C-u>UniteWithCursorWord grep:.<CR>
nnoremap <leader>/ :<C-u>Unite grep:.<CR>

map <C-o> <Plug>(unite_redraw)

au FileType unite call s:unite_settings()

function! s:unite_settings()
  let b:SuperTabDisabled=1
  nnoremap <silent><buffer><expr> <C-x> unite#do_action('split')
  nnoremap <silent><buffer><expr> <C-v> unite#do_action('vsplit')
  inoremap <silent><buffer><expr> <C-x> unite#do_action('split')
  inoremap <silent><buffer><expr> <C-v> unite#do_action('vsplit')
endfunction

let g:unite_source_grep_command = 'ag'
let g:unite_source_rec_async_command = ['ag', '--hidden', '--nocolor', '-g', '']
let g:unite_source_grep_default_opts = '--nogroup --nocolor --column -i'
let g:unite_source_grep_recursive_opts = ''

" NEOMAKE

let g:neomake_javascript_enabled_makers = ['eslint']
autocmd! BufWritePost,BufReadPost * Neomake
nmap <Leader><Space>o :lopen<CR>      " open location window
nmap <Leader><Space>c :lclose<CR>     " close location window
nmap <Leader><Space>, :ll<CR>         " go to current error/warning
nmap <Leader><Space>n :lnext<CR>      " next error/warning
nmap <Leader><Space>p :lprev<CR>      " previous error/warning

" VIM JSON

let g:vim_json_syntax_conceal = 0

if has('nvim')

  " DEOPLETE

  let g:deoplete#enable_at_startup = 1
  let g:deoplete#enable_smart_case = 1
  let g:deoplete#auto_completion_start_length = 1                                 " Set minimum syntax keyword length.

  inoremap <silent><expr> <Tab> pumvisible() ? "\<C-n>" : "\<Tab>"
  inoremap <silent><expr> <S-Tab> pumvisible() ? "\<C-p>" : "\<S-Tab>"

else

  " NEOCOMPLETE

  let g:acp_enableAtStartup = 0                                                   " disable autocomplete
  let g:neocomplete#enable_at_startup = 1                                         " enable neocomplete: https://github.com/Shougo/neocomplete.vim
  let g:neocomplete#enable_smart_case = 1
  let g:neocomplete#sources#syntax#min_keyword_length = 1                         " Set minimum syntax keyword length.
  let g:neocomplete#force_overwrite_completefunc = 1                              " fixes vim-clojure-static issue https://github.com/guns/vim-clojure-static/issues/54
  inoremap <expr><TAB> pumvisible() ? "\<C-n>" : "\<TAB>"                         " tab completion

endif

" RUST
let g:rustfmt_autosave = 1

" EDITORCONFIG

let g:EditorConfig_core_mode = 'external_command'
let g:EditorConfig_exclude_patterns = ['fugitive://.*']
