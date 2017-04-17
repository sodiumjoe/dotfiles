" plugins
" =======

call plug#begin('~/.vim/plugged')

Plug 'airblade/vim-gitgutter'
Plug 'chemzqm/vim-easygit'
Plug 'chemzqm/denite-extra'
Plug 'chemzqm/denite-git'
Plug 'easymotion/vim-easymotion'
Plug 'editorconfig/editorconfig-vim'
Plug 'junegunn/vim-slash'
Plug 'matze/vim-move'
Plug 'ntpeters/vim-better-whitespace'
Plug 'pbrisbin/vim-restore-cursor'
Plug 'sbdchd/neoformat'
Plug 'scrooloose/nerdtree'
Plug 'sheerun/vim-polyglot'
Plug 'Shougo/deoplete.nvim', { 'do': ':UpdateRemotePlugins' }
Plug 'Shougo/denite.nvim'
Plug 'sjl/clam.vim'
Plug 'tpope/vim-commentary'
Plug 'tpope/vim-fugitive'
Plug 'tpope/vim-repeat'
Plug 'tpope/vim-surround'
Plug 'trevordmiller/nova-vim'
Plug 'benizi/vim-automkdir'
Plug 'vimwiki/vimwiki'
Plug 'whatyouhide/vim-lengthmatters'
Plug 'w0rp/ale'

" has to load after other plugins
Plug 'ryanoasis/vim-devicons'

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
" enable pipe cursor in insert mode
let $NVIM_TUI_ENABLE_CURSOR_SHAPE=1
set diffopt=filler,vertical

map <space> <leader>
nnoremap <leader>p :set paste!<Cr>
" search visual selection
vnoremap // y/<C-R>"<CR>

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

hi StatusLineError guifg=#DF8C8C guibg=#556873
hi clear IncSearch
hi link IncSearch Visual
hi clear Search
hi link Search Visual

" statusline
" ==========

function! Git_branch()
  let l:branch = fugitive#head()
  return empty(l:branch)?'':'['.l:branch.']'
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
set statusline+=%{ALEGetStatusLine()}
" reset highlight group
set statusline+=%#StatusLine#
set statusline+=\ "
" line,column,virtual column
set statusline+=%-14.(%l,%c%V%)
set statusline+=\ "
" percentge through file of displayed window
set statusline+=%P

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
" cycle through location list
nnoremap <leader>n <Plug>(ale_next_wrap)

let g:ale_linters = {
\   'elixir': [],
\}

set inccommand=split

" deoplete

let g:deoplete#enable_at_startup = 1
let g:deoplete#enable_smart_case = 1
" Set minimum syntax keyword length.
let g:deoplete#auto_completion_start_length = 1
let g:deoplete#auto_complete_delay = 50

"clam

nnoremap ! :Clam<space>
vnoremap ! :ClamVisual<space>

" rust

let g:rustfmt_autosave = 1

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

" vim-easygit

" let g:easygit_enable_command = 1
nnoremap <leader>g :<C-u>Denite gitstatus -mode=normal<CR>
call denite#custom#map('normal', 'a', '<denite:do_action:add>',
      \ 'noremap')
call denite#custom#map('normal', 'd', '<denite:do_action:delete>',
      \ 'noremap')
call denite#custom#map('normal', 'r', '<denite:do_action:reset>',
      \ 'noremap')

" vim-gitgutter

let g:gitgutter_sign_column_always = 1

" neoformat

autocmd BufWritePre *.js Neoformat

let g:neoformat_enabled_javascript = ['prettier']
let g:neoformat_javascript_prettier = {
      \ 'exe': './node_modules/.bin/prettier',
      \ }
let g:neoformat_only_msg_on_error = 1
