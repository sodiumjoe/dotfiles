" Use Vim settings, rather than Vi settings (much better!).
" This must be first, because it changes other options as a side effect.
set nocompatible

"pathogen
call pathogen#infect()

" allow backspacing over everything in insert mode
set backspace=indent,eol,start

set history=50        " keep 50 lines of command line history
set ruler        " show the cursor position all the time
set showcmd        " display incomplete commands
set incsearch        " do incremental searching

" Don't use Ex mode, use Q for formatting
map Q gq

" CTRL-U in insert mode deletes a lot.  Use CTRL-G u to first break undo,
" so that you can undo CTRL-U after inserting a line break.
inoremap <C-U> <C-G>u<C-U>

" In many terminal emulators the mouse works just fine, thus enable it.
if has('mouse')
  set mouse=a
endif

" Switch syntax highlighting on, when the terminal has colors
" Also switch on highlighting the last used search pattern.
if &t_Co > 2 || has("gui_running")
  syntax on
  set hlsearch
endif

" Only do this part when compiled with support for autocommands.
if has("autocmd")

  " Enable file type detection.
  " Use the default filetype settings, so that mail gets 'tw' set to 72,
  " 'cindent' is on in C files, etc.
  " Also load indent files, to automatically do language-dependent indenting.
  filetype plugin indent on

  " Put these in an autocmd group, so that we can delete them easily.
  augroup vimrcEx
  au!

  " For all text files set 'textwidth' to 78 characters.
  autocmd FileType text setlocal textwidth=78

  " When editing a file, always jump to the last known cursor position.
  " Don't do it when the position is invalid or when inside an event handler
  " (happens when dropping a file on gvim).
  " Also don't do it when the mark is in the first line, that is the default
  " position when opening a file.
  autocmd BufReadPost *
    \ if line("'\"") > 1 && line("'\"") <= line("$") |
    \   exe "normal! g`\"" |
    \ endif

  augroup END

else

  set autoindent        " always set autoindenting on

endif " has("autocmd")

set guifont=Inconsolata:h16
" set background=dark
colorscheme Tomorrow-Night-Eighties
set guioptions-=T
set guioptions-=m  "remove menu bar
 autocmd BufRead *\.txt setlocal formatoptions=l
 autocmd BufRead *\.markdown setlocal formatoptions=l
 autocmd BufRead *\.txt setlocal lbr
 autocmd BufRead *\.markdown setlocal lbr
 autocmd BufRead *\.txt map  j gj
 autocmd BufRead *\.markdown map  j gj
 autocmd BufRead *\.txt  map  k gk
 autocmd BufRead *\.markdown map  k gk
 autocmd BufRead *\.txt setlocal smartindent
 autocmd BufRead *\.markdown setlocal smartindent
set nobackup
set nowritebackup
set enc=utf-8
set incsearch
set ignorecase
set smartcase

set tabstop=4
set shiftwidth=4
set nu

set scrolloff=10 "keep buffer of 10 lines above and below cursor

" folding column
set fdc=4
set showtabline=2

" Toggle line numbering modes
" Default to relativenumber in newer vim, otherwise regular numbering
"if v:version >= 703
    set number
    let s:relativenumber = 1
    function! <SID>ToggleRelativeNumber()
        if s:relativenumber == 0
            set number
            let s:relativenumber = 1
       " elseif s:relativenumber == 1
       "     set relativenumber
       "     let s:relativenumber = 2
        else
            set nonumber
            let s:relativenumber = 0
        endif
    endfunction
    map <silent><F10> :call <SID>ToggleRelativeNumber()<CR>
"else
"    set number
"endif

nmap ,f :FufFileWithCurrentBufferDir<CR>
nmap ,b :FufBuffer<CR>
nmap ,t :FufTaggedFile<CR>

" buffer:tab 1:1
:tab sball
:se switchbuf=usetab,newtab

:set timeout timeoutlen=1000 ttimeoutlen=100

set smartindent
set tabstop=4
set shiftwidth=4
set expandtab
