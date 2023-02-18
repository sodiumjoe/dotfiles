# Use beam shape cursor on startup.
# must go before instant prompt initialization
>$TTY echo -ne '\e[6 q'

# disable alacritty dock bouncing https://github.com/alacritty/alacritty/issues/2950
printf "\e[?1042l"

# Enable Powerlevel10k instant prompt. Should stay close to the top of ~/.config/zsh/.zshrc.
# Initialization code that may require console input (password prompts, [y/n]
# confirmations, etc.) must go above this block; everything else may go below.
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

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

export PATH=${PATH}:~/stripe/henson/bin
export PATH=${PATH}:~/stripe/password-vault/bin
export PATH=${PATH}:~/stripe/space-commander/bin
export PATH=${PATH}:~/stripe/go/bin
export PATH=${HOMEBREW_PREFIX}/opt/python/libexec/bin:${PATH}
export PATH=${HOMEBREW_PREFIX}/opt/curl/bin:${PATH}
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
export PATH=${PATH}:~/node-bin/node_modules/.bin

export RUSTUP_HOME=~/bin/rustup

# https://gpanders.com/blog/the-definitive-guide-to-using-tmux-256color-on-macos/
export TERMINFO_DIRS=$TERMINFO_DIRS:$HOME/.local/share/terminfo

export EDITOR='nvim -U none'
# open in editor
autoload -z edit-command-line
zle -N edit-command-line
bindkey -M vicmd v edit-command-line

# (ins mode)
bindkey -M viins '\e^?' backward-kill-word

# cursor shape
function zle-keymap-select {
    if [[ ${KEYMAP} == vicmd ]] || [[ $1 = 'block' ]]; then
        >$TTY echo -ne '\e[2 q'
    elif [[ ${KEYMAP} == main ]] || [[ ${KEYMAP} == viins ]] || [[ ${KEYMAP} = '' ]] || [[ $1 = 'beam' ]]; then
      if [[ ${ZLE_STATE} =~ "insert" ]]; then
        >$TTY echo -ne '\e[6 q'
      else
        >$TTY echo -ne '\e[4 q'
      fi
    fi
}

# Use beam shape cursor for each new prompt.
preexec() {
	>$TTY echo -ne '\e[6 q'
}

_fix_cursor() {
	>$TTY echo -ne '\e[6 q'
}
precmd_functions+=(_fix_cursor)

zle -N zle-keymap-select

# Enter normal mode immediately
KEYTIMEOUT=1

ZSH_AUTOSUGGEST_USE_ASYNC=1
ZSH_AUTOSUGGEST_MANUAL_REBIND=1
ZSH_AUTOSUGGEST_HISTORY_IGNORE="man *"

# dir aliases
[ -d ~/.dotfiles ] && hash -d dots=~/.dotfiles
[ -d ~/stripe/pay-server/manage/frontend ] && hash -d dashboard=~/stripe/pay-server/manage/frontend
[ -d ~/stripe/pay-server/manage ] && hash -d manage=~/stripe/pay-server/manage
[ -d ~/stripe/pay-server ] && hash -d pay=~/stripe/pay-server
[ -d /pay/src/pay-server/manage/frontend ] && hash -d dashboard=/pay/src/pay-server/manage/frontend
[ -d /pay/src/pay-server/manage ] && hash -d manage=/pay/src/pay-server/manage
[ -d /pay/src/pay-server ] && hash -d pay=/pay/src/pay-server
hash -d config=~/.config

# aliases

alias vim='nvim'
alias vi='nvim'

alias vimdiff='nvim -d'
if [ -x "$(command -v exa)" ]; then
  alias ll='exa -la'
else
  alias ll='ls -la'
fi
alias zd='cd ~/stripe/pay-server/manage/frontend'

# FZF

[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh
[ -f /usr/share/doc/fzf/examples/key-bindings.zsh ] && source /usr/share/doc/fzf/examples/key-bindings.zsh
[ -f /usr/share/doc/fzf/examples/completion.zsh ] && source /usr/share/doc/fzf/examples/completion.zsh

export FZF_DEFAULT_OPTS="--bind=ctrl-d:page-down,ctrl-u:page-up \
  --border=rounded \
  --height=100% \
  --color=dark,bg+:0,fg+:4,border:white,pointer:red \
  --pointer='▷ '\
  --prompt='❯ ' \
  --no-reverse"

# fbr - checkout git branch (including remote branches)
fbr() {
  local branches branch
  branches=$(git branch --format="%(refname:short)" --sort=-committerdate) &&
  branch=$(echo "$branches" | fzf) &&
  git checkout $branch
}

remotes() {
  local list remote
  list=$(pay remote list --raw | jq -r 'sort_by(.last_accessed) | reverse | .[] as {$name, $status, $last_accessed, spec: {source_specs: [{$git_ref}]}} | $last_accessed | localtime | strflocaltime("%c") as $last | [$name, "[\($status)]", "\($git_ref)", $last] | @tsv' | column -t)
  remote=$(echo "$list" | fzf)
  if [ ! -z $remote ]; then
    remote=$(echo "$remote" | cut -w -f 1)
    ssh -t $(pay remote ssh $remote -- hostname) "tmux a || tmux"
    tmux unnest
  fi
}

remote() {
  local branch
  branch="$(whoami)/$1"

  pay remote new "$1" -r "pay-server:$branch" --skip-confirm --no-open-code --notify-on-ready
  ssh -t $(pay remote ssh $1 -- hostname) "tmux a || tmux"
  tmux unnest
}

osc52copy() {
  local encoded
  encoded=$(echo $1 | base64)
  printf '\033]52;c;%s\a' $encoded
}

ghpr() {
  local origin owner branch url

  origin=$(git remote -v | grep origin | grep push | cut -d ':' -f 2 | cut -d '.' -f 1 | cut -d ' ' -f 1)
  # echo $origin

  owner=$(echo "$origin" | cut -d '/' -f 1)
  # echo $owner

  branch=$(git rev-parse --abbrev-ref HEAD)
  # echo $branch

  if [[ "$owner" == "stripe-internal" ]]; then
    url="https://git.corp.stripe.com/$origin/compare/$branch?expand=1"
  else
    url="https://github.com/$origin/pull/new/$branch"
  fi

  osc52copy $url
}

alias zz='z -c'      # restrict matches to subdirs of $PWD
alias zf='z -I'      # use fzf to select in multiple matches

# zsh-autosuggestions
bindkey '^n' autosuggest-accept

export RIPGREP_CONFIG_PATH=~/.config/rg/.ripgreprc

## stripe

chpwd() {
  if [[ $(pwd) == "/Users/moon/stripe/dashboard" ]]; then
    cd ~/stripe/pay-server/manage/frontend
  fi
}

if [ -d ~/stripe ]
then
  source ~/stripe/space-commander/bin/sc-aliases

  . /Users/moon/.rbenvrc
  . ~/.stripe-repos.sh

  export GOPATH=${HOME}/stripe/go
fi

eval "$(nodenv init -)"

# To customize prompt, run `p10k configure` or edit ~/.config/zsh/.p10k.zsh.
[[ ! -f ~/.config/zsh/.p10k.zsh ]] || source ~/.config/zsh/.p10k.zsh

alias luamake=/Users/joe/home/lua-language-server/3rd/luamake/luamake

# generated with https://github.com/sharkdp/vivid
# https://github.com/sodiumjoe/dotfiles/blob/5ec47fc22911ace3e7090d13fe0ef0629e3719a3/vivid/themes/sodium.yml
export LS_COLORS="ow=0:ca=0:ex=1;38;2;209;142;194:st=0:pi=0;38;2;30;39;44;48;2;127;193;202:tw=0:or=0;38;2;30;39;44;48;2;223;140;140:fi=0:so=0;38;2;30;39;44;48;2;209;142;194:di=1;38;2;131;175;229:bd=0;38;2;127;193;202;48;2;30;39;44:sg=0:su=0:cd=0;38;2;209;142;194;48;2;30;39;44:do=0;38;2;30;39;44;48;2;209;142;194:no=0:rs=0:ln=0;38;2;209;142;194:*~=0;38;2;85;104;115:mi=0;38;2;30;39;44;48;2;223;140;140:mh=0:*.o=0;38;2;85;104;115:*.p=0;38;2;131;175;229:*.h=0;38;2;131;175;229:*.a=1;38;2;209;142;194:*.c=0;38;2;131;175;229:*.r=0;38;2;131;175;229:*.t=0;38;2;131;175;229:*.z=4;38;2;209;142;194:*.d=0;38;2;131;175;229:*.m=0;38;2;131;175;229:*.cp=0;38;2;131;175;229:*.py=0;38;2;131;175;229:*.ko=1;38;2;209;142;194:*.ll=0;38;2;131;175;229:*.pm=0;38;2;131;175;229:*css=0;38;2;131;175;229:*.gv=0;38;2;131;175;229:*.el=0;38;2;131;175;229:*.mn=0;38;2;131;175;229:*.rb=0;38;2;131;175;229:*.td=0;38;2;131;175;229:*.kt=0;38;2;131;175;229:*.ps=0;38;2;242;195;143:*.ts=0;38;2;131;175;229:*.cc=0;38;2;131;175;229:*.ml=0;38;2;131;175;229:*.xz=4;38;2;209;142;194:*.so=1;38;2;209;142;194:*.bc=0;38;2;85;104;115:*.cs=0;38;2;131;175;229:*.fs=0;38;2;131;175;229:*.la=0;38;2;85;104;115:*.sh=0;38;2;131;175;229:*.rm=0;38;2;242;195;143:*.js=0;38;2;131;175;229:*.bz=4;38;2;209;142;194:*.di=0;38;2;131;175;229:*.nb=0;38;2;131;175;229:*.as=0;38;2;131;175;229:*.gz=4;38;2;209;142;194:*.pp=0;38;2;131;175;229:*.go=0;38;2;131;175;229:*.cr=0;38;2;131;175;229:*.ui=0;38;2;168;206;147:*.vb=0;38;2;131;175;229:*.md=0;38;2;218;218;147:*.hi=0;38;2;85;104;115:*.jl=0;38;2;131;175;229:*.rs=0;38;2;131;175;229:*.ex=0;38;2;131;175;229:*.hs=0;38;2;131;175;229:*.lo=0;38;2;85;104;115:*.hh=0;38;2;131;175;229:*.wv=0;38;2;242;195;143:*.7z=4;38;2;209;142;194:*.pl=0;38;2;131;175;229:*.tex=0;38;2;131;175;229:*.mkv=0;38;2;242;195;143:*.xlr=0;38;2;242;195;143:*.m4a=0;38;2;242;195;143:*.tif=0;38;2;242;195;143:*.mpg=0;38;2;242;195;143:*.ppt=0;38;2;242;195;143:*.exs=0;38;2;131;175;229:*.gvy=0;38;2;131;175;229:*.zst=4;38;2;209;142;194:*.com=1;38;2;209;142;194:*.jpg=0;38;2;242;195;143:*.out=0;38;2;85;104;115:*.inc=0;38;2;131;175;229:*.inl=0;38;2;131;175;229:*.pod=0;38;2;131;175;229:*.epp=0;38;2;131;175;229:*.ini=0;38;2;168;206;147:*.php=0;38;2;131;175;229:*.mir=0;38;2;131;175;229:*.bmp=0;38;2;242;195;143:*.bat=1;38;2;209;142;194:*.ind=0;38;2;85;104;115:*.odp=0;38;2;242;195;143:*.wav=0;38;2;242;195;143:*.htc=0;38;2;131;175;229:*.ics=0;38;2;242;195;143:*.asa=0;38;2;131;175;229:*.bst=0;38;2;168;206;147:*.fnt=0;38;2;242;195;143:*.pps=0;38;2;242;195;143:*.blg=0;38;2;85;104;115:*TODO=1:*.toc=0;38;2;85;104;115:*.arj=4;38;2;209;142;194:*.fls=0;38;2;85;104;115:*.bak=0;38;2;85;104;115:*.tmp=0;38;2;85;104;115:*.pid=0;38;2;85;104;115:*.pyo=0;38;2;85;104;115:*.mid=0;38;2;242;195;143:*.wmv=0;38;2;242;195;143:*.rtf=0;38;2;242;195;143:*.ppm=0;38;2;242;195;143:*.cgi=0;38;2;131;175;229:*.awk=0;38;2;131;175;229:*.pyc=0;38;2;85;104;115:*.dll=1;38;2;209;142;194:*.htm=0;38;2;218;218;147:*.sql=0;38;2;131;175;229:*.ltx=0;38;2;131;175;229:*.png=0;38;2;242;195;143:*.pbm=0;38;2;242;195;143:*.ogg=0;38;2;242;195;143:*.xcf=0;38;2;242;195;143:*.bag=4;38;2;209;142;194:*.swf=0;38;2;242;195;143:*.fsi=0;38;2;131;175;229:*.svg=0;38;2;242;195;143:*.sxw=0;38;2;242;195;143:*.h++=0;38;2;131;175;229:*.ttf=0;38;2;242;195;143:*.vim=0;38;2;131;175;229:*.clj=0;38;2;131;175;229:*.dpr=0;38;2;131;175;229:*.hpp=0;38;2;131;175;229:*.iso=4;38;2;209;142;194:*.csv=0;38;2;218;218;147:*.pgm=0;38;2;242;195;143:*.tml=0;38;2;168;206;147:*.dot=0;38;2;131;175;229:*.m4v=0;38;2;242;195;143:*.vob=0;38;2;242;195;143:*.cxx=0;38;2;131;175;229:*.bsh=0;38;2;131;175;229:*.def=0;38;2;131;175;229:*hgrc=0;38;2;168;206;147:*.bz2=4;38;2;209;142;194:*.log=0;38;2;85;104;115:*.txt=0;38;2;218;218;147:*.zip=4;38;2;209;142;194:*.img=4;38;2;209;142;194:*.mp4=0;38;2;242;195;143:*.dox=0;38;2;168;206;147:*.sty=0;38;2;85;104;115:*.ods=0;38;2;242;195;143:*.xml=0;38;2;218;218;147:*.sbt=0;38;2;131;175;229:*.fsx=0;38;2;131;175;229:*.vcd=4;38;2;209;142;194:*.idx=0;38;2;85;104;115:*.tbz=4;38;2;209;142;194:*.pyd=0;38;2;85;104;115:*.tar=4;38;2;209;142;194:*.exe=1;38;2;209;142;194:*.doc=0;38;2;242;195;143:*.hxx=0;38;2;131;175;229:*.tsx=0;38;2;131;175;229:*.tcl=0;38;2;131;175;229:*.aux=0;38;2;85;104;115:*.xmp=0;38;2;168;206;147:*.bin=4;38;2;209;142;194:*.pro=0;38;2;168;206;147:*.aif=0;38;2;242;195;143:*.wma=0;38;2;242;195;143:*.jar=4;38;2;209;142;194:*.mov=0;38;2;242;195;143:*.ipp=0;38;2;131;175;229:*.csx=0;38;2;131;175;229:*.fon=0;38;2;242;195;143:*.rst=0;38;2;218;218;147:*.pas=0;38;2;131;175;229:*.rar=4;38;2;209;142;194:*.xls=0;38;2;242;195;143:*.ilg=0;38;2;85;104;115:*.cfg=0;38;2;168;206;147:*.elm=0;38;2;131;175;229:*.bcf=0;38;2;85;104;115:*.swp=0;38;2;85;104;115:*.mp3=0;38;2;242;195;143:*.ps1=0;38;2;131;175;229:*.zsh=0;38;2;131;175;229:*.bbl=0;38;2;85;104;115:*.c++=0;38;2;131;175;229:*.psd=0;38;2;242;195;143:*.sxi=0;38;2;242;195;143:*.cpp=0;38;2;131;175;229:*.gif=0;38;2;242;195;143:*.yml=0;38;2;168;206;147:*.apk=4;38;2;209;142;194:*.nix=0;38;2;168;206;147:*.eps=0;38;2;242;195;143:*.odt=0;38;2;242;195;143:*.pkg=4;38;2;209;142;194:*.erl=0;38;2;131;175;229:*.mli=0;38;2;131;175;229:*.avi=0;38;2;242;195;143:*.ico=0;38;2;242;195;143:*.flv=0;38;2;242;195;143:*.kts=0;38;2;131;175;229:*.bib=0;38;2;168;206;147:*.tgz=4;38;2;209;142;194:*.otf=0;38;2;242;195;143:*.pdf=0;38;2;242;195;143:*.lua=0;38;2;131;175;229:*.deb=4;38;2;209;142;194:*.git=0;38;2;85;104;115:*.kex=0;38;2;242;195;143:*.dmg=4;38;2;209;142;194:*.rpm=4;38;2;209;142;194:*.pptx=0;38;2;242;195;143:*.make=0;38;2;168;206;147:*.rlib=0;38;2;85;104;115:*.epub=0;38;2;242;195;143:*.psd1=0;38;2;131;175;229:*.dart=0;38;2;131;175;229:*.purs=0;38;2;131;175;229:*.conf=0;38;2;168;206;147:*.mpeg=0;38;2;242;195;143:*.webm=0;38;2;242;195;143:*.tiff=0;38;2;242;195;143:*.fish=0;38;2;131;175;229:*.jpeg=0;38;2;242;195;143:*.lock=0;38;2;85;104;115:*.docx=0;38;2;242;195;143:*.orig=0;38;2;85;104;115:*.flac=0;38;2;242;195;143:*.diff=0;38;2;131;175;229:*.html=0;38;2;218;218;147:*.lisp=0;38;2;131;175;229:*.h264=0;38;2;242;195;143:*.json=0;38;2;168;206;147:*.opus=0;38;2;242;195;143:*.xlsx=0;38;2;242;195;143:*.yaml=0;38;2;168;206;147:*.bash=0;38;2;131;175;229:*.java=0;38;2;131;175;229:*.hgrc=0;38;2;168;206;147:*.psm1=0;38;2;131;175;229:*.less=0;38;2;131;175;229:*.tbz2=4;38;2;209;142;194:*.toml=0;38;2;168;206;147:*.shtml=0;38;2;218;218;147:*.ipynb=0;38;2;131;175;229:*.scala=0;38;2;131;175;229:*README=0;38;2;30;39;44;48;2;242;195;143:*.patch=0;38;2;131;175;229:*.swift=0;38;2;131;175;229:*shadow=0;38;2;168;206;147:*.xhtml=0;38;2;218;218;147:*.toast=4;38;2;209;142;194:*.cmake=0;38;2;168;206;147:*.dyn_o=0;38;2;85;104;115:*.cache=0;38;2;85;104;115:*passwd=0;38;2;168;206;147:*.cabal=0;38;2;131;175;229:*.mdown=0;38;2;218;218;147:*.class=0;38;2;85;104;115:*LICENSE=0;38;2;106;125;137:*.dyn_hi=0;38;2;85;104;115:*INSTALL=0;38;2;30;39;44;48;2;242;195;143:*.gradle=0;38;2;131;175;229:*.ignore=0;38;2;168;206;147:*.flake8=0;38;2;168;206;147:*.config=0;38;2;168;206;147:*.matlab=0;38;2;131;175;229:*COPYING=0;38;2;106;125;137:*.groovy=0;38;2;131;175;229:*TODO.md=1:*Makefile=0;38;2;168;206;147:*Doxyfile=0;38;2;168;206;147:*.desktop=0;38;2;168;206;147:*.gemspec=0;38;2;168;206;147:*setup.py=0;38;2;168;206;147:*TODO.txt=1:*.DS_Store=0;38;2;85;104;115:*COPYRIGHT=0;38;2;106;125;137:*.cmake.in=0;38;2;168;206;147:*.markdown=0;38;2;218;218;147:*.kdevelop=0;38;2;168;206;147:*README.md=0;38;2;30;39;44;48;2;242;195;143:*configure=0;38;2;168;206;147:*.rgignore=0;38;2;168;206;147:*.fdignore=0;38;2;168;206;147:*INSTALL.md=0;38;2;30;39;44;48;2;242;195;143:*.gitconfig=0;38;2;168;206;147:*.scons_opt=0;38;2;85;104;115:*.localized=0;38;2;85;104;115:*README.txt=0;38;2;30;39;44;48;2;242;195;143:*CODEOWNERS=0;38;2;168;206;147:*.gitignore=0;38;2;168;206;147:*Dockerfile=0;38;2;168;206;147:*SConstruct=0;38;2;168;206;147:*SConscript=0;38;2;168;206;147:*.synctex.gz=0;38;2;85;104;115:*.travis.yml=0;38;2;218;218;147:*INSTALL.txt=0;38;2;30;39;44;48;2;242;195;143:*.gitmodules=0;38;2;168;206;147:*LICENSE-MIT=0;38;2;106;125;137:*Makefile.am=0;38;2;168;206;147:*Makefile.in=0;38;2;85;104;115:*MANIFEST.in=0;38;2;168;206;147:*CONTRIBUTORS=0;38;2;30;39;44;48;2;242;195;143:*appveyor.yml=0;38;2;218;218;147:*.applescript=0;38;2;131;175;229:*configure.ac=0;38;2;168;206;147:*.fdb_latexmk=0;38;2;85;104;115:*.clang-format=0;38;2;168;206;147:*.gitattributes=0;38;2;168;206;147:*LICENSE-APACHE=0;38;2;106;125;137:*CMakeCache.txt=0;38;2;85;104;115:*CMakeLists.txt=0;38;2;168;206;147:*CONTRIBUTORS.md=0;38;2;30;39;44;48;2;242;195;143:*requirements.txt=0;38;2;168;206;147:*CONTRIBUTORS.txt=0;38;2;30;39;44;48;2;242;195;143:*.sconsign.dblite=0;38;2;85;104;115:*package-lock.json=0;38;2;85;104;115:*.CFUserTextEncoding=0;38;2;85;104;115"

# copied from .bash_profile
### BEGIN STRIPE
# All Stripe related shell configuration
# is at ~/.stripe/shellinit/bash_profile and is
# persistently managed by Chef. You shouldn't
# remove this unless you don't want to load
# Stripe specific shell configurations.
#
# Feel free to add your customizations in this
# file (~/.bash_profile) after the Stripe config
# is sourced.
if [[ -f ~/.stripe/shellinit/bash_profile ]]; then
  source ~/.stripe/shellinit/bash_profile
fi
### END STRIPE

# START - Managed by chef cookbook stripe_cpe_bin
alias tc='/usr/local/stripe/bin/test_cookbook'
alias cz='/usr/local/stripe/bin/chef-zero'
alias cookit='tc && cz'
# STOP - Managed by chef cookbook stripe_cpe_bin
