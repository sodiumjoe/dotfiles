# Start configuration added by Zim install {{{
#
# User configuration sourced by interactive shells
#

# -----------------
# Zsh configuration
# -----------------

#
# History
#

# Remove older command from the history if a duplicate is to be added.
setopt HIST_IGNORE_ALL_DUPS

#
# Input/output
#

# Set editor default keymap to emacs (`-e`) or vi (`-v`)
bindkey -v

# Prompt for spelling correction of commands.
#setopt CORRECT

# Customize spelling correction prompt.
#SPROMPT='zsh: correct %F{red}%R%f to %F{green}%r%f [nyae]? '

# Remove path separator from WORDCHARS.
WORDCHARS=${WORDCHARS//[\/]}


# --------------------
# Module configuration
# --------------------

#
# completion
#

# Set a custom path for the completion dump file.
# If none is provided, the default ${ZDOTDIR:-${HOME}}/.zcompdump is used.
zstyle ':zim:completion' dumpfile "${ZDOTDIR:-${HOME}}/.zcompdump-${ZSH_VERSION}"

#
# git
#

# Set a custom prefix for the generated aliases. The default prefix is 'G'.
#zstyle ':zim:git' aliases-prefix 'g'

#
# input
#

# Append `../` to your input for each `.` you type after an initial `..`
zstyle ':zim:input' double-dot-expand yes

#
# termtitle
#

# Set a custom terminal title format using prompt expansion escape sequences.
# See http://zsh.sourceforge.net/Doc/Release/Prompt-Expansion.html#Simple-Prompt-Escapes
# If none is provided, the default '%n@%m: %~' is used.
#zstyle ':zim:termtitle' format '%1~'

#
# zsh-autosuggestions
#

# Customize the style that the suggestions are shown with.
# See https://github.com/zsh-users/zsh-autosuggestions/blob/master/README.md#suggestion-highlight-style
ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE='fg=10'

#
# zsh-syntax-highlighting
#

# Set what highlighters will be used.
# See https://github.com/zsh-users/zsh-syntax-highlighting/blob/master/docs/highlighters.md
ZSH_HIGHLIGHT_HIGHLIGHTERS=(main brackets)

# Customize the main highlighter styles.
# See https://github.com/zsh-users/zsh-syntax-highlighting/blob/master/docs/highlighters/main.md#how-to-tweak-it
#typeset -A ZSH_HIGHLIGHT_STYLES
#ZSH_HIGHLIGHT_STYLES[comment]='fg=10'

# ------------------
# Initialize modules
# ------------------

if [[ ${ZIM_HOME}/init.zsh -ot ${ZDOTDIR:-${HOME}}/.zimrc ]]; then
  # Update static initialization script if it's outdated, before sourcing it
  source ${ZIM_HOME}/zimfw.zsh init -q
fi
source ${ZIM_HOME}/init.zsh

# ------------------------------
# Post-init module configuration
# ------------------------------

#
# zsh-history-substring-search
#

# Bind ^[[A/^[[B manually so up/down works both before and after zle-line-init
# bindkey '^[[A' history-substring-search-up
# bindkey '^[[B' history-substring-search-down

# Bind up and down keys
# zmodload -F zsh/terminfo +p:terminfo
# if [[ -n ${terminfo[kcuu1]} && -n ${terminfo[kcud1]} ]]; then
#   bindkey ${terminfo[kcuu1]} history-substring-search-up
#   bindkey ${terminfo[kcud1]} history-substring-search-down
# fi

# bindkey '^P' history-substring-search-up
# bindkey '^N' history-substring-search-down
# bindkey -M vicmd 'k' history-substring-search-up
# bindkey -M vicmd 'j' history-substring-search-down
# }}} End configuration added by Zim install

export PATH=~/stripe/henson/bin
export PATH=${PATH}:~/stripe/password-vault/bin
export PATH=${PATH}:~/stripe/space-commander/bin
export PATH=${PATH}:/usr/local/opt/python/libexec/bin
export PATH=${PATH}:/usr/local/opt/curl/bin
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
export PATH="/usr/local/go/bin:$PATH"
export PATH=${PATH}:~/stripe/go/bin
export PATH="${PATH}:/usr/local/opt/coreutils/libexec/gnubin"

export EDITOR='nvim -U none'
# open in editor
autoload -z edit-command-line
zle -N edit-command-line
bindkey -M vicmd v edit-command-line

# (ins mode)
bindkey -M viins '\e^?' backward-kill-word

# Enter normal mode immediately
KEYTIMEOUT=1

# pure prompt config
PURE_PROMPT_SYMBOL=➤
PURE_PROMPT_VICMD_SYMBOL=➤
PURE_GIT_UNTRACKED_DIRTY=0

zstyle :prompt:pure:prompt:success color blue
zstyle :prompt:pure:git:branch color white
zstyle :prompt:pure:git:branch:cached color yellow
zstyle :prompt:pure:git:dirty color red

# dir aliases
setopt AUTO_NAME_DIRS
setopt CDABLE_VARS
dashboard=~/stripe/pay-server/manage/frontend
pay=~/stripe/pay-server
manage=~/stripe/pay-server/manage
config=~/.config

# aliases

alias vim='nvim'
alias vi='nvim'

alias vimdiff='nvim -d'
alias iex='rlwrap -a foo iex'
alias del='rmtrash'
alias ll='exa -la'
alias zd='cd ~/stripe/pay-server/manage/frontend'

# FZF

[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh
export FZF_DEFAULT_OPTS="--bind=ctrl-d:page-down,ctrl-u:page-up \
  --height=100% \
  --no-bold \
  --color=dark,bg+:0,fg+:4 \
  --prompt='➤ ' \
  --no-reverse"

# fbr - checkout git branch (including remote branches)
fbr() {
  local branches branch
  branches=$(git branch --format="%(refname:short)" --sort=-committerdate) &&
  branch=$(echo "$branches" | fzf) &&
  git checkout $branch
}

chpwd() {
  if [[ $(pwd) == "/Users/moon/stripe/dashboard" ]]; then
    cd ~/stripe/pay-server/manage/frontend
  fi
}

eval "$(lua ${ZIM_HOME}/modules/z.lua/z.lua --init zsh enhanced once fzf)"

# zsh-autosuggestions
bindkey '^n' autosuggest-accept

export RIPGREP_CONFIG_PATH=~/.config/rg/.ripgreprc

## stripe

source ~/stripe/space-commander/bin/sc-aliases

. /Users/moon/.rbenvrc
. ~/.stripe-repos.sh
eval "$(nodenv init -)"

export GOPATH=${HOME}/stripe/go

# source /Users/moon/Library/Preferences/org.dystroy.broot/launcher/bash/br
