typeset -g _tmux_pending_command_started=0

_tmux_pending_preexec() {
  _tmux_pending_command_started=1
}

_tmux_pending_precmd() {
  if (( ! _tmux_pending_command_started )); then
    return
  fi

  _tmux_pending_command_started=0
  command tmux-pending mark "${TMUX_PANE:-}"
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec _tmux_pending_preexec
add-zsh-hook precmd _tmux_pending_precmd
