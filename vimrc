" legacy vim
" ==========

if !has('nvim')

  " vim settings, rather than vi settings
  " must be first, because it changes other options as a side effect
  set nocompatible
  set enc=utf8
  " keep 50 lines of command line history
  set history=50
  set laststatus=2
  " allow backspacing over everything in insert mode
  set backspace=indent,eol,start
  " incremental searching
  set incsearch
  " highlight last used search pattern
  set hlsearch
  set timeoutlen=1000 ttimeoutlen=10

endif

" plugins
" =======

call plug#begin('~/.vim/plugged')

Plug 'airblade/vim-gitgutter'
Plug 'altercation/vim-colors-solarized'
Plug 'easymotion/vim-easymotion'
Plug 'editorconfig/editorconfig-vim'
Plug 'jaawerth/nrun.vim'
Plug 'junegunn/vim-slash'
Plug 'matze/vim-move'
Plug 'ntpeters/vim-better-whitespace'
" Plug 'romainl/vim-qf'
Plug 'pbrisbin/vim-restore-cursor'
Plug 'Raimondi/delimitMate'
Plug 'scrooloose/nerdtree'
Plug 'sheerun/vim-polyglot'
if has('nvim')
  Plug 'Shougo/deoplete.nvim', { 'do': ':UpdateRemotePlugins' }
else
  Plug 'Shougo/neocomplete.vim'
endif
Plug 'Shougo/neoyank.vim'
Plug 'Shougo/unite.vim'
Plug 'sodiumjoe/unite-git'
Plug 'sodiumjoe/unite-qf'
Plug 'sjl/clam.vim'
Plug 'thinca/vim-unite-history'
Plug 'tpope/vim-commentary'
Plug 'tpope/vim-fugitive'
Plug 'tpope/vim-repeat'
Plug 'tpope/vim-surround'
Plug 'vimwiki/vimwiki'
Plug 'whatyouhide/vim-lengthmatters'
Plug 'w0rp/ale'

" has to load after other plugins
Plug 'ryanoasis/vim-devicons'

call plug#end()

" general
" =======

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
" enable pipe cursor in insert mode
let $NVIM_TUI_ENABLE_CURSOR_SHAPE=1
set diffopt=filler,vertical

map <space> <leader>
nnoremap <leader>p :set paste!<Cr>

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

au BufRead,BufNewFile ~/work/* setlocal noexpandtab
au BufRead,BufNewFile ~/work/elixir/* setlocal expandtab

" display
" =======

set guifont=Inconsolata:h16
set background=dark
colorscheme solarized
" folding column width
set fdc=2
" disable tabline
set showtabline=0
set autoindent
set smartindent
set ts=2
set sw=2
set expandtab
" keep buffer of lines above and below cursor
set scrolloff=5
" display incomplete commands
set showcmd
set textwidth=80

hi StatusLine cterm=NONE ctermfg=white ctermbg=black
hi StatusLineNC cterm=NONE ctermfg=black ctermbg=black
hi Folded ctermfg=black ctermbg=black cterm=NONE
hi FoldColumn cterm=bold ctermfg=blue ctermbg=NONE
hi SignColumn ctermbg=NONE
hi LineNr ctermbg=NONE
hi EndOfBuffer ctermfg=8 ctermbg=8
hi StatusLineError cterm=NONE ctermfg=1 ctermbg=black

" statusline
" ==========

function! Git_branch()
  let branch = fugitive#head()
  return empty(branch)?'':'['.branch.']'
endfunction

set statusline=\ "
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
set statusline+=%{ALEGetStatusLine()}
" reset highlight group
set statusline+=%#StatusLine#
set statusline+=\ "
" line,column,virtual column
set statusline+=%-14.(%l,%c%V%)
set statusline+=\ "
" percentge through file of displayed window
set statusline+=%P
set statusline+=\ "

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

" unite

let g:unite_source_history_yank_enable = 1
let g:unite_prompt = '❯ '
hi link uniteInputPrompt Function
call unite#filters#matcher_default#use(
      \['matcher_fuzzy', 'matcher_hide_current_file'])
call unite#custom#source(
      \'buffer,file,file_rec',
      \'sorters',
      \'sorter_selecta')
call unite#custom#profile('default', 'context', {
      \ 'start_insert': 1,
      \ 'prompt_focus': 1
      \})
call unite#custom#profile('grep', 'context', {
      \ 'no_start_insert': 1
      \})
nnoremap <C-p> :<C-u>Unite buffer file_rec/neovim<CR>
nnoremap <leader>y :<C-u>Unite history/yank<CR>
nnoremap <leader>s :<C-u>Unite buffer<CR>
nnoremap <leader>8 :<C-u>UniteWithCursorWord grep:.<CR>
nnoremap <leader>/ :<C-u>Unite grep:.<CR>
nnoremap <leader>d :<C-u>UniteWithBufferDir file_rec/neovim<CR>
nnoremap <leader>f :<C-u>Unite history/command -no-start-insert<CR>
nnoremap <leader><Space>/ :<C-u>Unite history/search -no-start-insert<CR>

map <C-o> <Plug>(unite_redraw)

au FileType unite call s:unite_settings()

function! s:unite_settings()
  let b:SuperTabDisabled=1
  nnoremap <silent><buffer><expr> <C-v> unite#do_action('vsplit')
  inoremap <silent><buffer><expr> <C-v> unite#do_action('vsplit')
  nnoremap <silent><buffer><expr> d unite#do_action('diff')
  nnoremap <silent><buffer><expr> - unite#do_action('stage')
endfunction

let g:unite_source_grep_command = 'rg'
let g:unite_source_rec_async_command = ['rg', '--files']
let g:unite_source_grep_default_opts = '--hidden --no-heading --vimgrep -S'
let g:unite_source_grep_recursive_opt = ''

" ale

let g:ale_sign_error = '⨉'
let g:ale_sign_warning = '⚠'
let g:ale_statusline_format = ['⨉ %d', '⚠ %d', '']
let g:ale_lint_on_text_changed = 0
let g:ale_lint_on_save = 1
" cycle through location list
nnoremap <leader>n <Plug>(ale_next_wrap)

if has('nvim')

  set inccommand=split

  " deoplete

  let g:deoplete#enable_at_startup = 1
  let g:deoplete#enable_smart_case = 1
  " Set minimum syntax keyword length.
  let g:deoplete#auto_completion_start_length = 1

  " tab completion
  inoremap <silent><expr> <Tab> pumvisible() ? "\<C-n>" : "\<Tab>"
  inoremap <silent><expr> <S-Tab> pumvisible() ? "\<C-p>" : "\<S-Tab>"

else

  " neocomplete

  " disable autocomplete
  let g:acp_enableAtStartup = 0
  " enable neocomplete: https://github.com/Shougo/neocomplete.vim
  let g:neocomplete#enable_at_startup = 1
  let g:neocomplete#enable_smart_case = 1
  " Set minimum syntax keyword length.
  let g:neocomplete#sources#syntax#min_keyword_length = 1
  " fixes vim-clojure-static issue
  " https://github.com/guns/vim-clojure-static/issues/54
  " let g:neocomplete#force_overwrite_completefunc = 1
  " tab completion
  inoremap <expr><TAB> pumvisible() ? "\<C-n>" : "\<TAB>"

endif

" clam

nnoremap ! :Clam<space>
vnoremap ! :ClamVisual<space>

" rust
let g:rustfmt_autosave = 1

" editorconfig

let g:EditorConfig_core_mode = 'external_command'
let g:EditorConfig_exclude_patterns = ['fugitive://.*']

" vimwiki

let work_wiki = {}
let work_wiki.path = '~/work/todo.wiki'
let work_wiki.path_html = '~/work/todo.html'

let play_wiki = {}
let play_wiki.path = '~/play/todo.wiki'
let play_wiki.path_html = '~/play/todo.html'

let g:vimwiki_list = [work_wiki, play_wiki]

" vim-lengthmatters

call lengthmatters#highlight_link_to('ColorColumn')

" vim-move
let g:move_key_modifier = 'C'

" vim-better-whitespace
hi link ExtraWhitespace Search

" unite-git

nnoremap <leader>g :<C-u>Unite -no-start-insert git_status<CR>

" unite-qf
nnoremap <leader>o :<C-u>Unite -no-start-insert location_list<CR>

" vim-gitgutter

let g:gitgutter_sign_column_always = 1
