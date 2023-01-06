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
[ -d ~/stripe/pay-server/manage/frontend ] && hash -d dashboard=~/stripe/pay-server/manage/frontend
[ -d ~/stripe/pay-server ] && hash -d pay=~/stripe/pay-server
[ -d ~/stripe/pay-server/manage ] && hash -d manage=~/stripe/pay-server/manage
[ -d /pay/src/pay-server/manage/frontend ] && hash -d dashboard=/pay/src/pay-server/manage/frontend
[ -d /psy/src/pay-server ] && hash -d pay=/pay/src/pay-server
[ -d /psy/src/pay-server/manage ] && hash -d manage=/pay/src/pay-server/manage
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
  --height=100% \
  --no-bold \
  --color=dark,bg+:0,fg+:4 \
  --prompt='➤  ' \
  --no-reverse"

# fbr - checkout git branch (including remote branches)
fbr() {
  local branches branch
  branches=$(git branch --format="%(refname:short)" --sort=-committerdate) &&
  branch=$(echo "$branches" | fzf) &&
  git checkout $branch
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
export LS_COLORS="or=0;38;2;30;39;44;48;2;223;140;140:ex=1;38;2;209;142;194:no=0:tw=0:di=1;38;2;131;175;229:ln=0;38;2;209;142;194:pi=0;38;2;30;39;44;48;2;127;193;202:so=0;38;2;30;39;44;48;2;209;142;194:cd=0;38;2;209;142;194;48;2;30;39;44:fi=0:do=0;38;2;30;39;44;48;2;209;142;194:ow=0:ca=0:rs=0:st=0:mh=0:mi=0;38;2;30;39;44;48;2;223;140;140:sg=0:bd=0;38;2;127;193;202;48;2;30;39;44:*~=0;38;2;85;104;115:su=0:*.z=4;38;2;209;142;194:*.m=0;38;2;131;175;229:*.h=0;38;2;131;175;229:*.d=0;38;2;131;175;229:*.t=0;38;2;131;175;229:*.p=0;38;2;131;175;229:*.o=0;38;2;85;104;115:*.c=0;38;2;131;175;229:*.a=1;38;2;209;142;194:*.r=0;38;2;131;175;229:*.el=0;38;2;131;175;229:*.rb=0;38;2;131;175;229:*.go=0;38;2;131;175;229:*.nb=0;38;2;131;175;229:*.td=0;38;2;131;175;229:*.ex=0;38;2;131;175;229:*.as=0;38;2;131;175;229:*.cc=0;38;2;131;175;229:*.mn=0;38;2;131;175;229:*.cr=0;38;2;131;175;229:*.la=0;38;2;85;104;115:*.bc=0;38;2;85;104;115:*.pl=0;38;2;131;175;229:*.so=1;38;2;209;142;194:*.wv=0;38;2;242;195;143:*.sh=0;38;2;131;175;229:*.hi=0;38;2;85;104;115:*.ps=0;38;2;242;195;143:*.md=0;38;2;218;218;147:*.ll=0;38;2;131;175;229:*.ml=0;38;2;131;175;229:*.rm=0;38;2;242;195;143:*.py=0;38;2;131;175;229:*.ui=0;38;2;168;206;147:*.xz=4;38;2;209;142;194:*.rs=0;38;2;131;175;229:*.lo=0;38;2;85;104;115:*.ts=0;38;2;131;175;229:*.fs=0;38;2;131;175;229:*.kt=0;38;2;131;175;229:*.ko=1;38;2;209;142;194:*.cs=0;38;2;131;175;229:*.di=0;38;2;131;175;229:*.jl=0;38;2;131;175;229:*.vb=0;38;2;131;175;229:*.gv=0;38;2;131;175;229:*.pm=0;38;2;131;175;229:*.js=0;38;2;131;175;229:*.pp=0;38;2;131;175;229:*.gz=4;38;2;209;142;194:*.7z=4;38;2;209;142;194:*css=0;38;2;131;175;229:*.bz=4;38;2;209;142;194:*.cp=0;38;2;131;175;229:*.hs=0;38;2;131;175;229:*.hh=0;38;2;131;175;229:*.mli=0;38;2;131;175;229:*.pbm=0;38;2;242;195;143:*.c++=0;38;2;131;175;229:*.hpp=0;38;2;131;175;229:*.doc=0;38;2;242;195;143:*.inc=0;38;2;131;175;229:*.elm=0;38;2;131;175;229:*.vim=0;38;2;131;175;229:*.ics=0;38;2;242;195;143:*.fnt=0;38;2;242;195;143:*.gvy=0;38;2;131;175;229:*.cgi=0;38;2;131;175;229:*.wma=0;38;2;242;195;143:*.svg=0;38;2;242;195;143:*.pas=0;38;2;131;175;229:*.ogg=0;38;2;242;195;143:*.jar=4;38;2;209;142;194:*.xml=0;38;2;218;218;147:*.rar=4;38;2;209;142;194:*.log=0;38;2;85;104;115:*.exs=0;38;2;131;175;229:*.mir=0;38;2;131;175;229:*.rtf=0;38;2;242;195;143:*.bbl=0;38;2;85;104;115:*.xmp=0;38;2;168;206;147:*.vob=0;38;2;242;195;143:*.pyc=0;38;2;85;104;115:*.tif=0;38;2;242;195;143:*.bin=4;38;2;209;142;194:*.dot=0;38;2;131;175;229:*.exe=1;38;2;209;142;194:*.tex=0;38;2;131;175;229:*.bmp=0;38;2;242;195;143:*.php=0;38;2;131;175;229:*.ttf=0;38;2;242;195;143:*.tcl=0;38;2;131;175;229:*.h++=0;38;2;131;175;229:*.git=0;38;2;85;104;115:*.hxx=0;38;2;131;175;229:*.htm=0;38;2;218;218;147:*.out=0;38;2;85;104;115:*.dpr=0;38;2;131;175;229:*.sxw=0;38;2;242;195;143:*.rst=0;38;2;218;218;147:*.csv=0;38;2;218;218;147:*.bz2=4;38;2;209;142;194:*.def=0;38;2;131;175;229:*.pod=0;38;2;131;175;229:*.cpp=0;38;2;131;175;229:*.bst=0;38;2;168;206;147:*.zsh=0;38;2;131;175;229:*.iso=4;38;2;209;142;194:*.apk=4;38;2;209;142;194:*.tar=4;38;2;209;142;194:*.pyd=0;38;2;85;104;115:*.awk=0;38;2;131;175;229:*.ind=0;38;2;85;104;115:*.pkg=4;38;2;209;142;194:*.fsi=0;38;2;131;175;229:*.zip=4;38;2;209;142;194:*.sql=0;38;2;131;175;229:*.idx=0;38;2;85;104;115:*.tgz=4;38;2;209;142;194:*.png=0;38;2;242;195;143:*.arj=4;38;2;209;142;194:*.cfg=0;38;2;168;206;147:*.wmv=0;38;2;242;195;143:*.kex=0;38;2;242;195;143:*hgrc=0;38;2;168;206;147:*.pid=0;38;2;85;104;115:*.mov=0;38;2;242;195;143:*.xcf=0;38;2;242;195;143:*.m4v=0;38;2;242;195;143:*.pgm=0;38;2;242;195;143:*.odp=0;38;2;242;195;143:*.sty=0;38;2;85;104;115:*.dox=0;38;2;168;206;147:*.vcd=4;38;2;209;142;194:*.swp=0;38;2;85;104;115:*.psd=0;38;2;242;195;143:*.deb=4;38;2;209;142;194:*.kts=0;38;2;131;175;229:*.sbt=0;38;2;131;175;229:*.epp=0;38;2;131;175;229:*.mid=0;38;2;242;195;143:*.sxi=0;38;2;242;195;143:*.ppm=0;38;2;242;195;143:*.tsx=0;38;2;131;175;229:*.gif=0;38;2;242;195;143:*.erl=0;38;2;131;175;229:*.yml=0;38;2;168;206;147:*.bat=1;38;2;209;142;194:*.pro=0;38;2;168;206;147:*.aux=0;38;2;85;104;115:*.txt=0;38;2;218;218;147:*.jpg=0;38;2;242;195;143:*TODO=1:*.bsh=0;38;2;131;175;229:*.odt=0;38;2;242;195;143:*.clj=0;38;2;131;175;229:*.blg=0;38;2;85;104;115:*.ods=0;38;2;242;195;143:*.bcf=0;38;2;85;104;115:*.xls=0;38;2;242;195;143:*.htc=0;38;2;131;175;229:*.swf=0;38;2;242;195;143:*.aif=0;38;2;242;195;143:*.dmg=4;38;2;209;142;194:*.avi=0;38;2;242;195;143:*.bag=4;38;2;209;142;194:*.tml=0;38;2;168;206;147:*.tmp=0;38;2;85;104;115:*.wav=0;38;2;242;195;143:*.eps=0;38;2;242;195;143:*.img=4;38;2;209;142;194:*.nix=0;38;2;168;206;147:*.fsx=0;38;2;131;175;229:*.lua=0;38;2;131;175;229:*.zst=4;38;2;209;142;194:*.tbz=4;38;2;209;142;194:*.ilg=0;38;2;85;104;115:*.rpm=4;38;2;209;142;194:*.ppt=0;38;2;242;195;143:*.mp3=0;38;2;242;195;143:*.ltx=0;38;2;131;175;229:*.ipp=0;38;2;131;175;229:*.cxx=0;38;2;131;175;229:*.ps1=0;38;2;131;175;229:*.pyo=0;38;2;85;104;115:*.otf=0;38;2;242;195;143:*.inl=0;38;2;131;175;229:*.m4a=0;38;2;242;195;143:*.pps=0;38;2;242;195;143:*.ini=0;38;2;168;206;147:*.dll=1;38;2;209;142;194:*.fls=0;38;2;85;104;115:*.xlr=0;38;2;242;195;143:*.flv=0;38;2;242;195;143:*.pdf=0;38;2;242;195;143:*.com=1;38;2;209;142;194:*.csx=0;38;2;131;175;229:*.bak=0;38;2;85;104;115:*.mkv=0;38;2;242;195;143:*.toc=0;38;2;85;104;115:*.ico=0;38;2;242;195;143:*.mp4=0;38;2;242;195;143:*.asa=0;38;2;131;175;229:*.fon=0;38;2;242;195;143:*.bib=0;38;2;168;206;147:*.mpg=0;38;2;242;195;143:*.opus=0;38;2;242;195;143:*.pptx=0;38;2;242;195;143:*.orig=0;38;2;85;104;115:*.lock=0;38;2;85;104;115:*.h264=0;38;2;242;195;143:*.webm=0;38;2;242;195;143:*.toml=0;38;2;168;206;147:*.fish=0;38;2;131;175;229:*.psm1=0;38;2;131;175;229:*.diff=0;38;2;131;175;229:*.docx=0;38;2;242;195;143:*.psd1=0;38;2;131;175;229:*.tiff=0;38;2;242;195;143:*.xlsx=0;38;2;242;195;143:*.make=0;38;2;168;206;147:*.flac=0;38;2;242;195;143:*.lisp=0;38;2;131;175;229:*.conf=0;38;2;168;206;147:*.hgrc=0;38;2;168;206;147:*.epub=0;38;2;242;195;143:*.less=0;38;2;131;175;229:*.mpeg=0;38;2;242;195;143:*.rlib=0;38;2;85;104;115:*.yaml=0;38;2;168;206;147:*.java=0;38;2;131;175;229:*.jpeg=0;38;2;242;195;143:*.json=0;38;2;168;206;147:*.html=0;38;2;218;218;147:*.dart=0;38;2;131;175;229:*.tbz2=4;38;2;209;142;194:*.purs=0;38;2;131;175;229:*.bash=0;38;2;131;175;229:*README=0;38;2;30;39;44;48;2;242;195;143:*.class=0;38;2;85;104;115:*.toast=4;38;2;209;142;194:*.dyn_o=0;38;2;85;104;115:*.mdown=0;38;2;218;218;147:*.cabal=0;38;2;131;175;229:*.cmake=0;38;2;168;206;147:*.shtml=0;38;2;218;218;147:*passwd=0;38;2;168;206;147:*.swift=0;38;2;131;175;229:*.patch=0;38;2;131;175;229:*.ipynb=0;38;2;131;175;229:*.cache=0;38;2;85;104;115:*shadow=0;38;2;168;206;147:*.xhtml=0;38;2;218;218;147:*.scala=0;38;2;131;175;229:*.dyn_hi=0;38;2;85;104;115:*.flake8=0;38;2;168;206;147:*TODO.md=1:*.config=0;38;2;168;206;147:*COPYING=0;38;2;106;125;137:*.ignore=0;38;2;168;206;147:*.matlab=0;38;2;131;175;229:*.gradle=0;38;2;131;175;229:*.groovy=0;38;2;131;175;229:*LICENSE=0;38;2;106;125;137:*INSTALL=0;38;2;30;39;44;48;2;242;195;143:*Doxyfile=0;38;2;168;206;147:*Makefile=0;38;2;168;206;147:*TODO.txt=1:*.gemspec=0;38;2;168;206;147:*setup.py=0;38;2;168;206;147:*.desktop=0;38;2;168;206;147:*.fdignore=0;38;2;168;206;147:*.markdown=0;38;2;218;218;147:*.cmake.in=0;38;2;168;206;147:*configure=0;38;2;168;206;147:*.DS_Store=0;38;2;85;104;115:*README.md=0;38;2;30;39;44;48;2;242;195;143:*.rgignore=0;38;2;168;206;147:*.kdevelop=0;38;2;168;206;147:*COPYRIGHT=0;38;2;106;125;137:*SConstruct=0;38;2;168;206;147:*Dockerfile=0;38;2;168;206;147:*README.txt=0;38;2;30;39;44;48;2;242;195;143:*.scons_opt=0;38;2;85;104;115:*.gitignore=0;38;2;168;206;147:*CODEOWNERS=0;38;2;168;206;147:*INSTALL.md=0;38;2;30;39;44;48;2;242;195;143:*SConscript=0;38;2;168;206;147:*.localized=0;38;2;85;104;115:*.gitconfig=0;38;2;168;206;147:*.gitmodules=0;38;2;168;206;147:*MANIFEST.in=0;38;2;168;206;147:*INSTALL.txt=0;38;2;30;39;44;48;2;242;195;143:*.travis.yml=0;38;2;218;218;147:*.synctex.gz=0;38;2;85;104;115:*LICENSE-MIT=0;38;2;106;125;137:*Makefile.in=0;38;2;85;104;115:*Makefile.am=0;38;2;168;206;147:*.applescript=0;38;2;131;175;229:*configure.ac=0;38;2;168;206;147:*.fdb_latexmk=0;38;2;85;104;115:*appveyor.yml=0;38;2;218;218;147:*CONTRIBUTORS=0;38;2;30;39;44;48;2;242;195;143:*.clang-format=0;38;2;168;206;147:*CMakeCache.txt=0;38;2;85;104;115:*CMakeLists.txt=0;38;2;168;206;147:*LICENSE-APACHE=0;38;2;106;125;137:*.gitattributes=0;38;2;168;206;147:*CONTRIBUTORS.md=0;38;2;30;39;44;48;2;242;195;143:*.sconsign.dblite=0;38;2;85;104;115:*requirements.txt=0;38;2;168;206;147:*CONTRIBUTORS.txt=0;38;2;30;39;44;48;2;242;195;143:*package-lock.json=0;38;2;85;104;115:*.CFUserTextEncoding=0;38;2;85;104;115"
