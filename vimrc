" GENERAL
" =======
set nocompatible                                            " Use Vim settings, rather than Vi settings (much better!).
                                                            " This must be first, because it changes other options as a side effect.
if has('mouse')
  set mouse=a                                               " enable mouse
endif

inoremap <C-U> <C-G>u<C-U>                                  " CTRL-U in insert mode deletes a lot. Use CTRL-G u to first break undo,
                                                            " so that you can undo CTRL-U after inserting a line break.
set nobackup
set nowritebackup
set dir=/tmp                                                " swap files to here
set noswapfile
set noerrorbells
set enc=utf-8

" PLUGINS
" ========
call pathogen#infect()                                      " Pathogen
set runtimepath^=~/.vim/bundle/ctrlp.vim                    " Ctrl-P

" EDITING
" =======
set backspace=indent,eol,start                              " allow backspacing over everything in insert mode
set history=50                                              " keep 50 lines of command line history
set ruler                                                   " show the cursor position all the time

" SEARCH
" ======
set showcmd                                                 " display incomplete commands
set incsearch                                               " do incremental searching
set ignorecase
set smartcase

" SYNTAX HIGHLIGHTING
" ===================
if &t_Co > 2 || has("gui_running")
  syntax on                                                 " Switch syntax highlighting on, when the terminal has colors
  set hlsearch                                              " Also switch on highlighting the last used search pattern.
endif

if has("autocmd")                                           " Only do this part when compiled with support for autocommands.
  filetype plugin indent on                                 " Enable file type detection.
                                                            " Use the default filetype settings, so that mail gets 'tw' set to 72,
                                                            " 'cindent' is on in C files, etc.
                                                            " Also load indent files, to automatically do language-dependent indenting.
  augroup vimrcEx                                           " Put these in an autocmd group, so that we can delete them easily.
  au!
  autocmd FileType text setlocal textwidth=78               " For all text files set 'textwidth' to 78 characters.
  autocmd BufReadPost *                                     " When editing a file, always jump to the last known cursor position.
    \ if line("'\"") > 1 && line("'\"") <= line("$") |      " Don't do it when the position is invalid or when inside an event handler
    \   exe "normal! g`\"" |                                " (happens when dropping a file on gvim).
    \ endif                                                 " Also don't do it when the mark is in the first line, that is the default
                                                            " position when opening a file.
  augroup END
else
  set autoindent                                            " always set autoindenting on
endif " has("autocmd")
autocmd Filetype html setlocal ts=2 sts=2 sw=2              " File type indents
autocmd Filetype ruby setlocal ts=2 sts=2 sw=2
autocmd Filetype jade setlocal ts=2 sts=2 sw=2
autocmd Filetype coffee setlocal ts=2 sts=2 sw=2
autocmd Filetype javascript setlocal ts=4 sts=4 sw=4

" DISPLAY
" =======
set guifont=Inconsolata:h16
set background=dark
let g:solarized_termtrans = 1
colorscheme solarized
syntax enable
set guioptions-=T
set guioptions-=m                                           " remove menu bar
set nu
set fdc=4                                                   " folding column
set showtabline=2
set smartindent
set tabstop=4
set shiftwidth=4
set expandtab
set scrolloff=5                                             " keep buffer of 10 lines above and below cursor
highlight ExtraWhitespace ctermbg=red guibg=red             " highlight trailing whitespace
match ExtraWhitespace /\s\+\%#\@<!$/

" MOVEMENT
" ========
nmap j gj
nmap k gk
