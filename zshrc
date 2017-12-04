

#
# User configuration sourced by interactive shells
#

# Change default zim location
export ZIM_HOME=${ZDOTDIR:-${HOME}}/.zim

# Start zim
[[ -s ${ZIM_HOME}/init.zsh ]] && source ${ZIM_HOME}/init.zsh # Source zim

ZSH_HIGHLIGHT_STYLES[path]='fg=cyan'

export PATH=/usr/local/bin:/bin:/usr/sbin:/sbin:/usr/bin:/usr/X11/bin:\
/usr/local/share/npm/bin:~/bin:~/.bin:~/.bin/terraform:~/npm/bin:~/.cargo/bin

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

alias lbr='lbr -i -p'
alias rg='rg --hidden -S'
alias work-chrome='open -n -a "Google Chrome" --args\
  --profile-directory="Profile 1"'
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

# added by travis gem
# [ -f /Users/jmoon/.travis/travis.sh ] && source /Users/jmoon/.travis/travis.sh

# eval $(docker-machine env an-vm)

source ~/play/per-directory-history/per-directory-history.zsh
source ~/play/z/z.sh
source ~/play/fz/fz.plugin.zsh
export NVM_LAZY_LOAD=true
source ~/play/zsh-nvm/zsh-nvm.plugin.zsh
source ~/play/zsh-better-npm-completion/zsh-better-npm-completion.plugin.zsh

export RUST_SRC_PATH="~/play/rust/src"

ulimit -n 65536 65536
