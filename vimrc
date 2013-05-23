" GENERAL
" =======

set nocompatible                                        " vim settings, rather than vi settings
                                                        " must be first, because it changes other options as a side effect
set mouse=a                                             " enable mouse
set nobackup
set nowritebackup
set dir=/tmp                                            " swap files go here
set noswapfile
set noerrorbells
set enc=utf-8
set timeoutlen=1000 ttimeoutlen=10

" PLUGINS
" ========

call pathogen#infect()                                  " Pathogen
set runtimepath^=~/.vim/bundle/ctrlp.vim                " Ctrl-P

" EDITING
" =======

set backspace=indent,eol,start                          " allow backspacing over everything in insert mode
set history=50                                          " keep 50 lines of command line history
set ruler                                               " show the cursor position all the time

" SEARCH
" ======

set showcmd                                             " display incomplete commands
set incsearch                                           " incremental searching
set ignorecase
set smartcase

" SYNTAX HIGHLIGHTING
" ===================

syntax on                                               " syntax highlighting
set hlsearch                                            " highlight last used search pattern
filetype plugin indent on                               " Enable file type detection.
autocmd BufReadPost *                                   " jump to the last known cursor position
  \ if line("'\"") > 1 && line("'\"") <= line("$") |    " except when position is invalid or inside an event handler
  \   exe "normal! g`\"" |                              " (happens when dropping a file on gvim).
  \ endif                                               " Also don't do it when the mark is in the first line, that is the default
autocmd Filetype html       setlocal ts=2 sts=2 sw=2    " File type indents
autocmd Filetype ruby       setlocal ts=2 sts=2 sw=2
autocmd Filetype jade       setlocal ts=2 sts=2 sw=2
autocmd Filetype coffee     setlocal ts=2 sts=2 sw=2
autocmd Filetype javascript setlocal ts=4 sts=4 sw=4

" DISPLAY
" =======

set guifont=Inconsolata:h16
set background=dark
let g:solarized_termtrans = 1
colorscheme solarized
syntax enable
set guioptions-=T
set guioptions-=m                                       " remove menu bar
set nu
set fdc=4                                               " folding column
set showtabline=2
set smartindent
set tabstop=4
set shiftwidth=4
set expandtab
set scrolloff=5                                         " keep buffer of 10 lines above and below cursor
highlight ExtraWhitespace ctermbg=red guibg=red         " highlight trailing whitespace
match ExtraWhitespace /\s\+\%#\@<!$/

" MOVEMENT
" ========

nmap j gj
nmap k gk
