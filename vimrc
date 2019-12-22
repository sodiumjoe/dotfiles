" plugins
" =======

call plug#begin('~/.vim/plugged')

Plug 'Shougo/denite.nvim'
Plug 'Shougo/deoplete.nvim', { 'do': ':UpdateRemotePlugins' }
Plug 'airblade/vim-gitgutter'
Plug 'benizi/vim-automkdir'
Plug 'easymotion/vim-easymotion'
Plug 'editorconfig/editorconfig-vim'
Plug 'haya14busa/incsearch-easymotion.vim'
Plug 'haya14busa/incsearch.vim'
Plug 'junegunn/goyo.vim'
Plug 'justinmk/vim-dirvish'
Plug 'matze/vim-move'
Plug 'neoclide/denite-git'
Plug 'ntpeters/vim-better-whitespace'
Plug 'rhysd/conflict-marker.vim'
Plug 'sbdchd/neoformat'
Plug 'sheerun/vim-polyglot'
Plug 'tpope/vim-commentary'
Plug 'tpope/vim-eunuch'
Plug 'tpope/vim-fugitive'
Plug 'tpope/vim-repeat'
Plug 'tpope/vim-surround'
Plug 'trevordmiller/nova-vim'
Plug 'vimwiki/vimwiki'
Plug 'w0rp/ale'
Plug 'whatyouhide/vim-lengthmatters'

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
" always show the cursor position
set ruler
set smartcase
set infercase
set diffopt=filler,vertical
set breakindent

let g:mapleader="\<SPACE>"
" search visual selection
vnoremap // y/<C-R>"<CR>

" move line up
cnoremap <C-k> <Up>
" move line down
cnoremap <C-j> <Down>
" copy relative path to clipboard
nmap <silent> <leader>cr :let @+ = expand("%")<cr>
" copy full path to clipboard
nmap <silent> <leader>cf :let @+ = expand("%:p")<cr>

if executable('rg')
  set grepprg=rg\ --vimgrep\ --no-heading\ -S
  set grepformat=%f:%l:%c:%m,%f:%l:%m
endif

set inccommand=split

" restore cursor pos
autocmd BufReadPost *
      \ if line("'\"") > 1 && line("'\"") <= line("$") && &ft !~# 'commit'
      \ |   exe "normal! g`\""
      \ | endif

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

" split dividers and end of buffer character
set fillchars=vert:\│,eob:⌁
hi VertSplit guifg=#556873

hi clear IncSearch
hi link IncSearch StatusLine
hi clear Search
hi link Search StatusLine

" statusline
" ==========

hi StatusLine guifg=#C5D4DD guibg=#556873
hi StatusLineNC guifg=#3C4C55 guibg=#556873
hi StatusLineError guifg=#DF8C8C guibg=#556873

function! LinterStatus() abort
  let l:counts = ale#statusline#Count(bufnr(''))

  let l:all_errors = l:counts.error + l:counts.style_error
  let l:all_non_errors = l:counts.total - l:all_errors

  return l:counts.total == 0 ? '' : printf(
        \   '%d⚠ %d⨉',
        \   all_non_errors,
        \   all_errors
        \)
endfunction

set statusline=
" filename
set statusline+=\ %<%{expand('%:~:.')}
set statusline+=\ "
" help/modified/readonly
set statusline+=%(%h%m%r%)
" alignment group
set statusline+=%=
" start error highlight group
set statusline+=%#StatusLineError#
" errors from w0rp/ale
set statusline+=%{LinterStatus()}
set statusline+=\ "

" javascript source resolution
set path=.
set suffixesadd=.js,.jsx

function! LoadMainNodeModule(fname)
    let nodeModules = "./node_modules/"
    let packageJsonPath = nodeModules . a:fname . "/package.json"

    if filereadable(packageJsonPath)
        return nodeModules . a:fname . "/" . json_decode(join(readfile(packageJsonPath))).main
    else
        return nodeModules . a:fname
    endif
endfunction

set includeexpr=LoadMainNodeModule(v:fname)

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

call denite#custom#option('default', {
      \ 'prompt': '❯'
      \ })

call denite#custom#var('file/rec', 'command',
      \ ['fd', '-H', '--full-path'])
call denite#custom#var('grep', 'command', ['rg'])
call denite#custom#var('grep', 'default_opts',
      \ ['--hidden', '--vimgrep', '--smart-case'])
call denite#custom#var('grep', 'recursive_opts', [])
call denite#custom#var('grep', 'pattern_opt', ['--regexp'])
call denite#custom#var('grep', 'separator', ['--'])
call denite#custom#var('grep', 'final_opts', [])

autocmd FileType denite call s:denite_settings()

function! s:denite_settings() abort
  nnoremap <silent><buffer><expr> <CR>
        \ denite#do_map('do_action')
  nnoremap <silent><buffer><expr> <C-v>
        \ denite#do_map('do_action', 'vsplit')
  nnoremap <silent><buffer><expr> d
        \ denite#do_map('do_action', 'delete')
  nnoremap <silent><buffer><expr> p
        \ denite#do_map('do_action', 'preview')
  nnoremap <silent><buffer><expr> <Esc>
        \ denite#do_map('quit')
  nnoremap <silent><buffer><expr> q
        \ denite#do_map('quit')
  nnoremap <silent><buffer><expr> i
        \ denite#do_map('open_filter_buffer')
endfunction

autocmd FileType denite-filter call s:denite_filter_settings()

function! s:denite_filter_settings() abort
  nmap <silent><buffer> <Esc> <Plug>(denite_filter_quit)
endfunction

nnoremap <C-p> :<C-u>Denite file/rec -start-filter<CR>
nnoremap <leader>s :<C-u>Denite buffer<CR>
nnoremap <leader>8 :<C-u>DeniteCursorWord grep:.<CR>
nnoremap <leader>/ :<C-u>Denite grep:.<CR>
nnoremap <leader><Space>/ :<C-u>DeniteBufferDir grep:.<CR>
nnoremap <leader>d :<C-u>DeniteBufferDir file/rec -start-filter<CR>
nnoremap <leader>r :<C-u>Denite -resume -cursor-pos=+1<CR>
nnoremap <leader><C-r> :<C-u>Denite register:.<CR>
nnoremap <leader>g :<C-u>Denite gitstatus<CR>

hi link deniteMatchedChar Special

" ale

let g:ale_sign_error = '⨉'
let g:ale_sign_warning = '⚠'
let g:ale_statusline_format = ['⨉ %d', '⚠ %d', '']
" cycle through location list
nmap <silent> <leader>n <Plug>(ale_next_wrap)
nmap <silent> <leader>p <Plug>(ale_previous_wrap)

let g:ale_linters = {
      \   'elixir': [],
      \   'javascript': ['eslint', 'flow', 'flow-language-server'],
      \   'javascript.jsx': ['eslint', 'flow', 'flow-language-server'],
      \   'coffeescript': ['jshint'],
      \}

" https://github.com/w0rp/ale/issues/2560#issuecomment-500166527
let g:ale_linters_ignore = {
      \   'javascript': ['flow-language-server'],
      \   'javascript.jsx': ['flow-language-server'],
      \}

let g:ale_rust_cargo_use_check = 1
let g:ale_ruby_rubocop_executable = 'bundle'

nnoremap <silent> K :ALEHover<CR>
nnoremap <silent> gd :ALEGoToDefinition<CR>
nnoremap <silent> gvd :ALEGoToDefinitionInVSplit<CR>
nnoremap <silent> gr :ALEFindReferences<CR>

" deoplete

let g:deoplete#enable_at_startup = 1

call deoplete#custom#option({
      \   'min_pattern_length': 1,
      \   'auto_complete_delay': 50,
      \})

" disable deoplete for denite buffer
autocmd FileType denite-filter
      \   call deoplete#custom#buffer_option('auto_complete', v:false)

" editorconfig

let g:EditorConfig_exclude_patterns = ['fugitive://.*']

" vimwiki

let g:wiki = {}
let g:wiki.path = '~/home/todo.wiki'
let g:wiki.syntax = 'markdown'
let g:work_wiki = {}
let g:work_wiki.path = '~/stripe/todo.wiki'
let g:work_wiki.path_html = '~/stripe/todo.html'
let g:work_wiki.syntax = 'markdown'

let g:vimwiki_list = [g:work_wiki, g:wiki]
map <leader>wp <Plug>VimwikiDiaryPrevDay
map <leader>wn <Plug>VimwikiDiaryNextDay

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
      \'gitcommit',
      \'json'
      \]

" vim-move

let g:move_key_modifier = 'C'

" vim-better-whitespace

hi link ExtraWhitespace Search

" vim-gitgutter

set signcolumn=yes

" neoformat

augroup fmt
  autocmd!
  autocmd BufWritePre *.{js,jsx,rs,go} silent! Neoformat
augroup END

augroup Alacritty
  autocmd!
  autocmd BufNewFile,BufRead ~/home/alacritty/**/* autocmd! fmt
augroup END

let g:neoformat_enabled_javascript = ['prettier', 'prettier2']
let g:neoformat_javascript_prettier = {
      \ 'exe': './node_modules/.bin/prettier',
      \ 'args': ['--write', '--config .prettierrc'],
      \ 'replace': 1
      \ }
let g:neoformat_javascript_prettier2 = {
      \ 'exe': './node_modules/.bin/prettier',
      \ 'args': ['--write', '--config ../../prettier.config.js'],
      \ 'replace': 1
      \ }

let g:neoformat_enabled_rust = ['rustfmt']
let g:neoformat_enabled_go = ['goimports', 'gofmt']

" incsearch

set hlsearch
let g:incsearch#auto_nohlsearch = 1
map n  <Plug>(incsearch-nohl-n)
map N  <Plug>(incsearch-nohl-N)
map *  <Plug>(incsearch-nohl-*)
map #  <Plug>(incsearch-nohl-#)
map g* <Plug>(incsearch-nohl-g*)
map g# <Plug>(incsearch-nohl-g#)

" incsearch-easymotion

map / <Plug>(incsearch-easymotion-/)
map ? <Plug>(incsearch-easymotion-?)
map g/ <Plug>(incsearch-easymotion-stay)

" dirvish

augroup dirvish_config
  autocmd!
  autocmd FileType dirvish silent! unmap <buffer> <C-p>
augroup END

augroup dirvish_fugitive
  autocmd!
  autocmd FileType dirvish call fugitive#detect(@%)
augroup end

" vim-markdown
let g:vim_markdown_strikethrough = 1
let g:vim_markdown_new_list_item_indent = 2

" goyo

function! s:goyo_enter()
  LengthmattersDisable
  set linebreak
endfunction

function! s:goyo_leave()
  LengthmattersEnable
  hi StatusLine guifg=#7FC1CA guibg=#556873
  hi StatusLineNC guifg=#3C4C55 guibg=#556873
  hi StatusLineError guifg=#DF8C8C guibg=#556873
  set nolinebreak
endfunction

autocmd! User GoyoEnter nested call <SID>goyo_enter()
autocmd! User GoyoLeave nested call <SID>goyo_leave()
