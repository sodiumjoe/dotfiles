" LEGACY VIM
" ==========

if !has('nvim')

  " vim settings, rather than vi settings
  " must be first, because it changes other options as a side effect
  set nocompatible
  set enc=utf-8
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

" PLUGINS
" =======

call plug#begin('~/.vim/plugged')

Plug 'airblade/vim-gitgutter'
Plug 'altercation/vim-colors-solarized'
Plug 'benekastah/neomake'
Plug 'easymotion/vim-easymotion'
Plug 'editorconfig/editorconfig-vim'
Plug 'elixir-lang/vim-elixir'
Plug 'gavocanov/vim-js-indent'
Plug 'jaawerth/nrun.vim'
Plug 'junegunn/vim-slash'
Plug 'matze/vim-move'
Plug 'mxw/vim-jsx'
Plug 'ntpeters/vim-better-whitespace'
Plug 'othree/yajs.vim'
Plug 'romainl/vim-qf'
Plug 'pbrisbin/vim-restore-cursor'
" Plug 'rust-lang/rust.vim'
if has('nvim')
  Plug 'Shougo/deoplete.nvim', { 'do': ':UpdateRemotePlugins' }
else
  Plug 'Shougo/neocomplete.vim'
endif
Plug 'Shougo/neoyank.vim'
Plug 'Shougo/vimproc.vim', { 'do': 'make' }
Plug 'Shougo/unite.vim'
Plug 'scrooloose/nerdtree'
Plug 'sjl/clam.vim'
Plug 'thinca/vim-unite-history'
Plug 'tpope/vim-commentary'
Plug 'tpope/vim-fugitive'
Plug 'tpope/vim-markdown'
Plug 'tpope/vim-repeat'
Plug 'tpope/vim-surround'
Plug 'vimwiki/vimwiki'
Plug 'whatyouhide/vim-lengthmatters'

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

map <space> <leader>
nmap <leader>p :set paste!<Cr>

" MOVEMENT
" ========

nmap j gj
nmap k gk

" SEARCH
" ======

" display incomplete commands
nnoremap <leader>n :<C-u>noh<CR>
set ignorecase

" SYNTAX HIGHLIGHTING
" ===================

syntax on
filetype plugin indent on

set nomodeline

au BufRead,BufNewFile ~/work/* setlocal noexpandtab
au BufRead,BufNewFile ~/work/elixir/* setlocal expandtab

" DISPLAY
" =======

set guifont=Inconsolata:h16
set background=dark
colorscheme solarized
" folding column width
set fdc=1
" disable tabline
set showtabline=0
set autoindent
set smartindent
set ts=2
set sw=2
set expandtab
" keep buffer of lines above and below cursor
set scrolloff=5
set showcmd
set textwidth=80

hi StatusLine cterm=NONE ctermfg=white ctermbg=black
hi StatusLineNC cterm=NONE ctermfg=black ctermbg=black
hi Folded ctermfg=black ctermbg=black cterm=NONE
hi FoldColumn cterm=bold ctermfg=blue ctermbg=NONE
hi SignColumn ctermbg=NONE
hi LineNr ctermbg=NONE
hi EndOfBuffer ctermfg=8 ctermbg=8

function! Git_branch()
  let branch = fugitive#head()
  return empty(branch)?'':'['.branch.']'
endfunction

set statusline=\ %{Git_branch()}\ %<%F\ %h%m%r%=%-14.(%l,%c%V%)\ %P\ "

" PLUGIN CONFIGS
" ==============

" EASYMOTION

map <Leader>e <Plug>(easymotion-prefix)

" disable shading
let g:EasyMotion_do_shade = 0

" colors
hi EasyMotionTarget ctermfg=1 cterm=bold,underline
hi link EasyMotionTarget2First EasyMotionTarget
hi EasyMotionTarget2Second ctermfg=1 cterm=underline

" VIM-STATIC-CLOJURE

" let g:clojure_fuzzy_indent = 0

" UNITE

let g:unite_source_history_yank_enable = 1
call unite#filters#matcher_default#use(['matcher_fuzzy'])
call unite#filters#sorter_default#use(['sorter_length'])
nnoremap <C-p> :<C-u>Unite -start-insert buffer file_rec/async<CR>
nnoremap <leader>y :<C-u>Unite history/yank<CR>
nnoremap <leader>s :<C-u>Unite -start-insert buffer<CR>
nnoremap <leader>8 :<C-u>UniteWithCursorWord grep:.<CR>
nnoremap <leader>/ :<C-u>Unite grep:.<CR>
nnoremap <leader>d :<C-u>UniteWithBufferDir
  \ -start-insert buffer file_rec/async<CR>
nnoremap <leader>f :<C-u>Unite -start-insert history/command<CR>
nnoremap <leader><Space>/ :<C-u>Unite -start-insert history/search<CR>

map <C-o> <Plug>(unite_redraw)

au FileType unite call s:unite_settings()

function! s:unite_settings()
  let b:SuperTabDisabled=1
  nnoremap <silent><buffer><expr> <C-x> unite#do_action('split')
  nnoremap <silent><buffer><expr> <C-v> unite#do_action('vsplit')
  inoremap <silent><buffer><expr> <C-x> unite#do_action('split')
  inoremap <silent><buffer><expr> <C-v> unite#do_action('vsplit')
endfunction

let g:unite_source_grep_command = 'rg'
let g:unite_source_rec_async_command = ['rg', '--files']
let g:unite_source_grep_default_opts = '--hidden --no-heading --vimgrep -S'
let g:unite_source_grep_recursive_opt = ''

" NEOMAKE

let g:neomake_javascript_enabled_makers = ['eslint']
let g:neomake_javascript_eslint_exe = nrun#Which('eslint')
autocmd! BufWritePost,BufReadPost * Neomake
" open location window
nmap <Leader><Space>o :lopen<CR>
" close location window
nmap <Leader><Space>c :lclose<CR>
" cycle through location list
nmap <Leader><Space> <Plug>QfLprevious

" VIM JSON

let g:vim_json_syntax_conceal = 0

if has('nvim')

  set inccommand=split

  " DEOPLETE

  let g:deoplete#enable_at_startup = 1
  let g:deoplete#enable_smart_case = 1
  " Set minimum syntax keyword length.
  let g:deoplete#auto_completion_start_length = 1

  " tab completion
  inoremap <silent><expr> <Tab> pumvisible() ? "\<C-n>" : "\<Tab>"
  inoremap <silent><expr> <S-Tab> pumvisible() ? "\<C-p>" : "\<S-Tab>"

else

  " NEOCOMPLETE

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

" CLAM

nnoremap ! :Clam<space>
vnoremap ! :ClamVisual<space>

" RUST
let g:rustfmt_autosave = 1

" EDITORCONFIG

let g:EditorConfig_core_mode = 'external_command'
let g:EditorConfig_exclude_patterns = ['fugitive://.*']

" VIMWIKI

let work_wiki = {}
let work_wiki.path = '~/work/todo.wiki'
let work_wiki.path_html = '~/work/todo.html'

let play_wiki = {}
let play_wiki.path = '~/play/todo.wiki'
let play_wiki.path_html = '~/play/todo.html'

let g:vimwiki_list = [work_wiki, play_wiki]

" LENGTH MATTERS
"
call lengthmatters#highlight_link_to('ColorColumn')

" VIM-MOVE
let g:move_key_modifier = 'C'

" VIM-BETTER-WHITESPACE
hi link ExtraWhitespace Search
