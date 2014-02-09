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
set splitbelow
set splitright

set exrc                                                " enable per-directory .vimrc files
set secure                                              " disable unsafe commands in local .vimrc files

set nojoinspaces                                        " Insert only one space when joining lines that contain sentence-terminating
                                                        " punctuation like `.`.

set clipboard=unnamed                                   " send to system clipboard: https://coderwall.com/p/g-d8rg

" PLUGINS
" =======

call pathogen#infect()                                  " Pathogen

filetype plugin on
let g:instant_markdown_autostart = 0                    " For instant markdown: https://github.com/suan/vim-instant-markdown
let g:calendar_google_calendar = 1                      " calendar.vim: https://github.com/itchyny/calendar.vim


" UNITE
" =====

let g:unite_source_history_yank_enable = 1
call unite#filters#matcher_default#use(['matcher_fuzzy'])
call unite#custom#source('file_rec/async', 'ignore_pattern', 'node_modules/\|bower_components/')
nnoremap <C-p> :<C-u>Unite -start-insert buffer file_rec/async<CR>
nnoremap <space>y :<C-u>Unite history/yank<CR>
nnoremap <space>s :<C-u>Unite -start-insert buffer<CR>
nnoremap <space>/ :<C-u>Unite grep:.<cr>

:map <C-o> <Plug>(unite_redraw)

let g:unite_source_grep_command = 'ag'
let g:unite_source_rec_async_command = 'ag -f --nofilter'
let g:unite_source_grep_default_opts = '--noheading --nocolor'
let g:unite_source_grep_recursive_opts = ''


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
autocmd Filetype javascript setlocal ts=2 sts=2 sw=2

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

hi! VertSplit ctermfg=Black                             " split border color
hi! StatusLine ctermfg=LightGray                        " status line color
hi! StatusLineNC ctermfg=Black                          " inactive status line color
set fillchars+=vert:\ 

" MOVEMENT
" ========

nmap j gj
nmap k gk

