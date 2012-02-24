" source $VIMRUNTIME/vimrc_example.vim
" source $VIMRUNTIME/mswin.vim
" behave mswin


set diffexpr=MyDiff()
function MyDiff()
  let opt = '-a --binary '
  if &diffopt =~ 'icase' | let opt = opt . '-i ' | endif
  if &diffopt =~ 'iwhite' | let opt = opt . '-b ' | endif
  let arg1 = v:fname_in
  if arg1 =~ ' ' | let arg1 = '"' . arg1 . '"' | endif
  let arg2 = v:fname_new
  if arg2 =~ ' ' | let arg2 = '"' . arg2 . '"' | endif
  let arg3 = v:fname_out
  if arg3 =~ ' ' | let arg3 = '"' . arg3 . '"' | endif
  let eq = ''
  if $VIMRUNTIME =~ ' '
    if &sh =~ '\<cmd'
      let cmd = '""' . $VIMRUNTIME . '\diff"'
      let eq = '"'
    else
      let cmd = substitute($VIMRUNTIME, ' ', '" ', '') . '\diff"'
    endif
  else
    let cmd = $VIMRUNTIME . '\diff'
  endif
  silent execute '!' . cmd . ' ' . opt . arg1 . ' ' . arg2 . ' > ' . arg3 . eq
endfunction
" An example for a vimrc file.
"
" Maintainer:	Bram Moolenaar <Bram@vim.org>
" Last change:	2008 Dec 17
"
" To use it, copy it to
"     for Unix and OS/2:  ~/.vimrc
"	      for Amiga:  s:.vimrc
"  for MS-DOS and Win32:  $VIM\_vimrc
"	    for OpenVMS:  sys$login:.vimrc

" When started as "evim", evim.vim will already have done these settings.
if v:progname =~? "evim"
  finish
endif

" Use Vim settings, rather than Vi settings (much better!).
" This must be first, because it changes other options as a side effect.
set nocompatible

" allow backspacing over everything in insert mode
set backspace=indent,eol,start

if has("vms")
  set nobackup		" do not keep a backup file, use versions instead
else
  set backup		" keep a backup file
endif
set history=50		" keep 50 lines of command line history
set ruler		" show the cursor position all the time
set showcmd		" display incomplete commands
set incsearch		" do incremental searching

" For Win32 GUI: remove 't' flag from 'guioptions': no tearoff menu entries
" let &guioptions = substitute(&guioptions, "t", "", "g")

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

  set autoindent		" always set autoindenting on

endif " has("autocmd")

" Convenient command to see the difference between the current buffer and the
" file it was loaded from, thus the changes you made.
" Only define it when not defined already.
if !exists(":DiffOrig")
  command DiffOrig vert new | set bt=nofile | r # | 0d_ | diffthis
		  \ | wincmd p | diffthis
endif
set guifont=Inconsolata:h16
colorscheme slate
highlight FoldColumn guifg=white guibg=grey15
highlight NonText ctermfg=white guifg=grey15
set guioptions-=T
set guioptions-=m  "remove menu bar
 autocmd BufRead *\.txt setlocal formatoptions=l
 autocmd BufRead *\.txt setlocal lbr
 autocmd BufRead *\.txt map  j gj
 autocmd BufRead *\.txt  map  k gk
 autocmd BufRead *\.txt setlocal smartindent
set nobackup
set nowritebackup
set enc=utf-8
set incsearch
set ignorecase
set smartcase

" Pandoc Conversion from markdown to html

function Convert()
	!pandoc -o %:r.html -f markdown % -S
	e %:r.html
	%s/\n\s*>/>/g
	%s/\/p></\/p>\r\r</g
	%s/\/h3></\/h3>\r\r</g
	%s/\/li><li/\/li>\r\r<li/g
	%s/<div/\r\r<div/g
	%s/<hr\s*\n\s*\/>/\r\r<hr \/>\r\r/g
	%s/<ol>/<ol>\r/g
	%s/<\/ol>/\r<\/ol>/g
	%s/<\/div>/\r<\/div>\r/g
	w
endfunction

function Clt()
	%s/’/'/g
	%s/“/"/g
	%s/”/"/g
	%s/‘/'/g
	%s/’/'/g
	%s/…/.../g
	%s/_/\\_/g
	w
	bd
endfunction

set tabstop=4
set shiftwidth=4
set nu

set undofile "Persistent Undo
set undodir=$home\dropbox\vimtemp\

set scrolloff=10 "keep buffer of 10 lines above and below cursor

" folding column
set fdc=4
hi FoldColumn guibg=grey15

" always show tab bar
set showtabline=2


" Toggle line numbering modes
" Default to relativenumber in newer vim, otherwise regular numbering
"if v:version >= 703
    set number
    let s:relativenumber = 1
    function! <SID>ToggleRelativeNumber()
        if s:relativenumber == 0
            set number
			syntax on
			highlight NonText ctermfg=white guifg=grey15
			hi FoldColumn guibg=grey15
            let s:relativenumber = 1
       " elseif s:relativenumber == 1
       "     set relativenumber
       "     let s:relativenumber = 2
        else
            set nonumber
			syntax off
			hi FoldColumn guibg=grey15
			highlight NonText ctermfg=white guifg=grey15
            let s:relativenumber = 0
        endif
    endfunction
    map <silent><F10> :call <SID>ToggleRelativeNumber()<CR>
"else
"    set number
"endif

function! WordCount()
  let s:old_status = v:statusmsg
  let position = getpos(".")
  exe ":silent normal g\"
  let stat = v:statusmsg
  let s:word_count = 0
  if stat != '--No lines in buffer--'
    let s:word_count = str2nr(split(v:statusmsg)[11])
    let v:statusmsg = s:old_status
  end
  call setpos('.', position)
  return s:word_count 
endfunction

nmap ,f :FufFileWithCurrentBufferDir<CR>
nmap ,b :FufBuffer<CR>
nmap ,t :FufTaggedFile<CR>


" buffer:tab 1:1
:tab sball
:se switchbuf=usetab,newtab
