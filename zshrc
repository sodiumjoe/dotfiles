# Path to your oh-my-zsh configuration.
ZSH=$HOME/.oh-my-zsh

# Set name of the theme to load.
ZSH_THEME=joebadmo

# Which plugins would you like to load? (plugins can be found in ~/.oh-my-zsh/plugins/*)
# Custom plugins may be added to ~/.oh-my-zsh/custom/plugins/
# Example format: plugins=(rails git textmate ruby lighthouse)
plugins=(git)

source $ZSH/oh-my-zsh.sh

# Customize to your needs...
export PATH=/usr/local/bin:/bin:/usr/sbin:/sbin:/usr/bin:/usr/X11/bin:/usr/local/share/npm/bin:~/.bin:/Users/joe/packer:

# More extensive tab completion
autoload -U compinit
compinit

# case-insensitive tab completion
zstyle ':completion:*' matcher-list 'm:{a-zA-Z}={A-Za-z}'

# turn off autocorrect
unsetopt correct_all

# vi mode
bindkey -v
bindkey '^[[A' up-line-or-search
bindkey '^[[B' down-line-or-search
KEYTIMEOUT=1

# emacs keybindings in vi mode

### (ins mode)
bindkey -M viins '^?'   backward-delete-char
bindkey -M viins '^H'   backward-delete-char
bindkey -M viins '^a'   beginning-of-line
bindkey -M viins '^e'   end-of-line
bindkey -M viins '\e^?' backward-kill-word

### (cmd mode)
bindkey -M vicmd '^a'   beginning-of-line
bindkey -M vicmd '^e'   end-of-line
bindkey -M vicmd '^w'   backward-kill-word
bindkey -M vicmd '/'    vi-history-search-forward
bindkey -M vicmd '?'    vi-history-search-backward
bindkey -M vicmd '\ef'  forward-word                      # Alt-f
bindkey -M vicmd '\eb'  backward-word                     # Alt-b
bindkey -M vicmd '\ed'  kill-word                         # Alt-d

# reverse search in vi mode
bindkey "^R" history-incremental-search-backward

# environment variables
export NODE_PATH='/usr/local/lib/node_modules'
# export JAVA_HOME=$(/usr/libexec/java_home -v 1.7)
export VAGRANT_DEFAULT_PROVIDER='vmware_fusion'

# boxen
[ -f /opt/boxen/env.sh ] && source /opt/boxen/env.sh

# use macvim in terminal instead of vim to keep system clipboard functionality
alias vim="/opt/boxen/homebrew/bin/reattach-to-user-namespace mvim -v"

# rbenv
eval "$(rbenv init -)"

# hub https://github.com/github/hub
eval "$(hub alias -s)"

# ondir https://github.com/alecthomas/ondir
cd() {
  builtin cd "$@" && eval "`ondir \"$OLDPWD\" \"$PWD\"`"
}
pushd() {
  builtin pushd "$@" && eval "`ondir \"$OLDPWD\" \"$PWD\"`"
}
popd() {
  builtin popd "$@" && eval "`ondir \"$OLDPWD\" \"$PWD\"`"
}
eval "`ondir /`"

# aliases

alias ll="ls -lah"
alias ssh="ssh -F $SSH_CONFIG"


# added by travis gem
[ -f /Users/joe/.travis/travis.sh ] && source /Users/joe/.travis/travis.sh
