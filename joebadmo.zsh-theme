ZSH_THEME_GIT_PROMPT_PREFIX="[%{%B%F{white}%}± %{%b%F{yellow}%}"
ZSH_THEME_GIT_PROMPT_SUFFIX="%f"
ZSH_THEME_GIT_PROMPT_DIRTY=" %{%F{red}%}✗%f] "
ZSH_THEME_GIT_PROMPT_CLEAN="%f] "

PROMPT='$(git_prompt_info)%{%b%F{blue}%}${PWD/#$HOME/~} ➤  %f'
