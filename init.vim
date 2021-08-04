" general
" =======

lua << EOF
vim.o.runtimepath = vim.o.runtimepath .. [[,~/.dotfiles/neovim]]
EOF

lua require('sodium/init')

" restore cursor pos
autocmd BufReadPost *
      \ if line("'\"") > 1 && line("'\"") <= line("$") && &ft !~# 'commit'
      \ |   exe "normal! g`\""
      \ | endif


lua << EOF
require('sodium.statusline')
EOF

" plugin configs
" ==============

lua require('sodium/configs')
