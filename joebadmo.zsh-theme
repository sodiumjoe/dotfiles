ZSH_THEME_GIT_PROMPT_PREFIX="[%{%B%F{white}%}± %{%b%F{yellow}%}"
ZSH_THEME_GIT_PROMPT_SUFFIX="%f"
ZSH_THEME_GIT_PROMPT_DIRTY=" %{%F{red}%}✗%f] "
ZSH_THEME_GIT_PROMPT_CLEAN="%f] "

prompt_context() {
  if [[ $(hostname -s) != 'jmoon' ]]; then
    echo -n '%{%B%F{white}%}%n@%m%f '
  fi
}

PROMPT='$(prompt_context)$(git_prompt_info)%{%b%F{blue}%}${PWD/#$HOME/~} ➤  %f'
