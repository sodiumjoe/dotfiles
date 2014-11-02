" GENERAL
" =======

set nocompatible                                                                " vim settings, rather than vi settings
                                                                                " must be first, because it changes other options as a side effect
set mouse=a                                                                     " enable mouse
set backupdir=~/.vim/backups
set directory=~/.vim/swaps
set undofile
set undodir=~/.vim/undo
set noerrorbells
set enc=utf-8
set timeoutlen=1000 ttimeoutlen=10
set splitbelow
set splitright

set exrc                                                                        " enable per-directory .vimrc files
set secure                                                                      " disable unsafe commands in local .vimrc files

set nojoinspaces                                                                " Insert only one space when joining lines that contain sentence-terminating
                                                                                " punctuation like `.`.

set clipboard+=unnamed                                                           " send to system clipboard: https://coderwall.com/p/g-d8rg
set shortmess=aoOtI                                                             " don't show intro message

map <space> <leader>
:nmap <leader><Space> :w<Cr>
:nmap <leader>p :set paste!<Cr>

" PLUGINS
" =======

call pathogen#infect()                                                          " Pathogen

filetype plugin on
let g:instant_markdown_autostart = 0                                            " For instant markdown: https://github.com/suan/vim-instant-markdown
let g:calendar_google_calendar = 1                                              " calendar.vim: https://github.com/itchyny/calendar.vim

" NEOCOMPLETE
" ===========

let g:acp_enableAtStartup = 0                                                   " disable autocomplete
let g:neocomplete#enable_at_startup = 1                                         " enable neocomplete: https://github.com/Shougo/neocomplete.vim
let g:neocomplete#enable_smart_case = 1
let g:neocomplete#sources#syntax#min_keyword_length = 1                         " Set minimum syntax keyword length.
inoremap <expr><TAB>  pumvisible() ? "\<C-n>" : "\<TAB>"

" UNITE
" =====

let g:unite_source_history_yank_enable = 1
call unite#filters#matcher_default#use(['matcher_fuzzy'])
call unite#custom#source('file_rec/async', 'ignore_pattern', 'node_modules/\|bower_components/\|.git/\|.bundle/\|\.vagrant/|.bin/')
nnoremap <C-p> :<C-u>Unite -start-insert buffer file_rec/async<CR>
nnoremap <leader>y :<C-u>Unite history/yank<CR>
nnoremap <leader>s :<C-u>Unite -start-insert buffer<CR>
nnoremap <leader>8 :<C-u>UniteWithCursorWord grep:.<CR>
nnoremap <leader>/ :<C-u>Unite grep:.<CR>
" noremap <leader>* :<C-u>Unite grep:.::<C-R><C-w><CR>

:map <C-o> <Plug>(unite_redraw)

autocmd FileType unite call s:unite_settings()

function! s:unite_settings()
  let b:SuperTabDisabled=1
  imap <silent><buffer><expr> <C-x> unite#do_action('split')
  imap <silent><buffer><expr> <C-v> unite#do_action('vsplit')

  nmap <buffer> <ESC> <Plug>(unite_exit)
endfunction

let g:unite_source_grep_command = 'ag'
let g:unite_source_rec_async_command = 'ag --hidden --nocolor -g ""'
let g:unite_source_grep_default_opts = '--nogroup --nocolor --column -i'
let g:unite_source_grep_recursive_opts = ''

" SYNTASTIC
" =========

let g:syntastic_javascript_syntax_checker='jshint'

" EDITING
" =======

set backspace=indent,eol,start                                                  " allow backspacing over everything in insert mode
set history=50                                                                  " keep 50 lines of command line history
set ruler                                                                       " show the cursor position all the time

" SEARCH
" ======

set showcmd                                                                     " display incomplete commands
set incsearch                                                                   " incremental searching
set ignorecase
set smartcase
nnoremap <leader>n :<C-u>noh<CR>


" SYNTAX HIGHLIGHTING
" ===================

syntax on                                                                       " syntax highlighting
set hlsearch                                                                    " highlight last used search pattern
filetype plugin indent on                                                       " Enable file type detection.
autocmd BufReadPost *                                                           " jump to the last known cursor position
  \ if line("'\"") > 1 && line("'\"") <= line("$") |                            " except when position is invalid or inside an event handler
  \   exe "normal! g`\"" |                                                      " (happens when dropping a file on gvim).
  \ endif                                                                       " Also don't do it when the mark is in the first line, that is the default
autocmd Filetype html       setlocal ts=2 sts=2 sw=2                            " File type indents
autocmd Filetype ruby       setlocal ts=2 sts=2 sw=2
autocmd Filetype jade       setlocal ts=2 sts=2 sw=2
autocmd Filetype coffee     setlocal ts=2 sts=2 sw=2
autocmd Filetype javascript setlocal ts=2 sts=2 sw=2
autocmd Filetype puppet     setlocal ts=2 sts=2 sw=2
autocmd Filetype yaml       setlocal ts=2 sts=2 sw=2
autocmd Filetype sh         setlocal ts=2 sts=2 sw=2
autocmd Filetype lua        setlocal ts=2 sts=2 sw=2

au BufRead,BufNewFile *.pjs setfiletype javascript

set modelines=0
set nomodeline

autocmd BufRead,BufNewFile ~/work/* setlocal noexpandtab

" VIM JSON
" ========

let g:vim_json_syntax_conceal = 0

" DISPLAY
" =======

set guifont=Inconsolata:h16
set background=dark
let g:solarized_termtrans = 1
colorscheme solarized
" colorscheme base16-default
syntax enable
set guioptions-=T
set guioptions-=m                                                               " remove menu bar
set nu
set fdc=4                                                                       " folding column
set showtabline=2
set smartindent
set tabstop=4
set shiftwidth=4
set expandtab
set scrolloff=5                                                                 " keep buffer of 10 lines above and below cursor
highlight ExtraWhitespace ctermbg=red guibg=red                                 " highlight trailing whitespace
match ExtraWhitespace /\s\+\%#\@<!$/

hi! VertSplit ctermfg=Black                                                     " split border color
hi! StatusLine ctermfg=LightGray                                                " status line color
hi! StatusLineNC ctermfg=Black                                                  " inactive status line color
set fillchars+=vert:\ 

" let &colorcolumn=join(range(81,999),",")                                        " highlight after 80 characters

" MOVEMENT
" ========

nmap j gj
nmap k gk
