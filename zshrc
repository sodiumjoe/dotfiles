

#
# User configuration sourced by interactive shells
#

# Change default zim location
export ZIM_HOME=${ZDOTDIR:-${HOME}}/.zim

# Start zim
[[ -s ${ZIM_HOME}/init.zsh ]] && source ${ZIM_HOME}/init.zsh # Source zim

ZSH_HIGHLIGHT_STYLES[path]='fg=cyan'

export PATH=~/stripe/henson/bin
export PATH=${PATH}:node_modules/.bin
export PATH=${PATH}:~/stripe/password-vault/bin
export PATH=${PATH}:~/stripe/space-commander/bin
export PATH=${PATH}:/usr/local/opt/python/libexec/bin
export PATH=${PATH}:/usr/local/bin
export PATH=${PATH}:/bin
export PATH=${PATH}:/usr/sbin
export PATH=${PATH}:/sbin
export PATH=${PATH}:/usr/bin
export PATH=${PATH}:/usr/X11/bin
export PATH=${PATH}:/usr/local/share/npm/bin
export PATH=${PATH}:~/bin
export PATH=${PATH}:~/.bin
export PATH=${PATH}:~/.bin/terraform
export PATH=${PATH}:~/npm/bin
export PATH=${PATH}:~/.cargo/bin

export EDITOR=nvim
# open in editor
autoload -z edit-command-line
zle -N edit-command-line
bindkey -M vicmd v edit-command-line

# (ins mode)
bindkey -M viins '\e^?' backward-kill-word

# Enter normal mode immediately
KEYTIMEOUT=1

# aliases

alias vim='nvim'
alias vi='nvim'

alias rg='rg --hidden -S'
alias vimdiff='nvim -d'
alias iex='rlwrap -a foo iex'
alias del='rmtrash'
alias rm="echo Use 'del', or the full path i.e. '/bin/rm'"
unalias ls
alias ll='ls -lah'

# FZF

[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh
export FZF_DEFAULT_OPTS="--bind=ctrl-d:page-down,ctrl-u:page-up \
  --height=100% \
  --no-bold \
  --color=dark,bg+:0,fg+:4 \
  --prompt='❯❯❯ ' \
  --no-reverse"

# fbr - checkout git branch (including remote branches)
fbr() {
  local branches branch
  branches=$(git branch --format="%(refname:short)" --sort=-committerdate) &&
  branch=$(echo "$branches" | fzf) &&
  git checkout $branch
}

# per-directory git config
if which karn > /dev/null; then eval "$(karn init)"; fi

source ~/.dotfiles/per-directory-history/per-directory-history.zsh
source ~/.dotfiles/z/z.sh
source ~/.dotfiles/fz/fz.plugin.zsh
# export NVM_LAZY_LOAD=true
# source ~/.dotfiles/zsh-nvm/zsh-nvm.plugin.zsh
# source ~/.dotfiles/zsh-better-npm-completion/zsh-better-npm-completion.plugin.zsh

## stripe

. /Users/moon/.rbenvrc
. ~/.stripe-repos.sh
eval "$(nodenv init -)"
