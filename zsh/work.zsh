# Stripe PATH entries
export PATH=${PATH}:~/stripe/henson/bin
export PATH=${PATH}:~/stripe/password-vault/bin
export PATH=${PATH}:~/stripe/space-commander/bin
export PATH=${PATH}:~/stripe/go/bin
export PATH=${PATH}:~/stripe/.cargo/bin
export PATH=${PATH}:~/stripe/.cargo/env

# Stripe named dirs
_sodium_define_stripe_named_dirs /pay/src/pay-server "$HOME/stripe/mint/pay-server"

# Stripe git aliases (green = Stripe's main branch)
alias gfm='git fetch origin green:green'
alias grm='git rebase green'

# ghpr: open GitHub/corp PR URL for current branch
ghpr() {
  local origin owner branch url

  origin=$(git remote -v | grep origin | grep push | cut -d ':' -f 2 | cut -d '.' -f 1 | cut -d ' ' -f 1)
  owner=$(echo "$origin" | cut -d '/' -f 1)
  branch=$(git rev-parse --abbrev-ref HEAD)

  if [[ "$owner" == "stripe-internal" ]]; then
    url="https://git.corp.stripe.com/$origin/compare/$branch?expand=1"
  else
    url="https://github.com/$origin/pull/new/$branch"
  fi

  osc52copy $url
}

# Devbox and work sync
source "${ZDOTDIR:-${HOME}/.config/zsh}/work_sync.zsh"

fetch_remotes() {
  local list=$(\
    pay remote list --raw \
    | jq -r '
      sort_by(.last_accessed)
      | reverse
      | .[]
      | . as {$name, $status, $last_accessed_human_readable, $emoji, $go_dev_url}
      | (
          [.current_working_copies // [] | .[] | select(.branch != "green")]
          | sort_by(.commit_timestamp) | reverse | first // null
        ) as $wc
      | ($wc | if . then .branch else "" end) as $branch
      | ["[" + $emoji + "]" + $name, "[\($status)]", $branch, $go_dev_url, $last_accessed_human_readable]
      | @tsv
    '\
    | column -t \
  )
  print -r -- "$list"
}

remotes() {
  local picked=$(fzf < <(fetch_remotes))
  [ -z "$picked" ] && return 0
  local remote_name=$(echo "$picked" | cut -w -f 1 | cut -d ] -f 2)

  _devbox_start_if_needed "$remote_name" || return

  local host=$(_devbox_host_for_remote "$remote_name")

  _devbox_sync "$host"
  _devbox_sync_loop "$host"

  _devbox_attach_tmux "$host"
  local exit_code=$?
  tmux unnest 2>/dev/null

  _devbox_sync_loop_stop "$host"
  _devbox_sync "$host"

  if [ $exit_code -eq 255 ] || [ $exit_code -eq 1 ]; then
    reset
  fi
}

godev() {
  remote=$(fzf < <(fetch_remotes))
  if [ ! -z "$remote" ]; then
    echo "$remote" | cut -w -f 3
  fi
}

remote() {
  local remote_name="$1"
  local branch="$(_devbox_branch "$remote_name")"

  pay remote new "$remote_name" --repo "mint:$branch" --workspace pay-server --skip-confirm --no-open-code --notify-on-ready || return

  local host=$(_devbox_host_for_remote "$remote_name")

  _devbox_sync "$host"
  _devbox_sync_loop "$host"

  _devbox_attach_tmux "$host"
  local exit_code=$?
  tmux unnest 2>/dev/null

  _devbox_sync_loop_stop "$host"
  _devbox_sync "$host"

  if [ $exit_code -eq 255 ] || [ $exit_code -eq 1 ]; then
    reset
    echo "disconnected from $remote_name"
  fi
}

remote_url() {
  osc52copy $(pay remote url $remote_name "$@")
}

# Stripe environment variables
if [ -d ~/stripe ]; then
  export GOPATH="${HOME}/stripe/go"
  export CARGO_HOME="${HOME}/stripe/.cargo"
  export RUSTUP_HOME=~/stripe/.rustup
  export STRIPE_CLAUDE_DISABLE_SPINNER_VERBS=1
fi

# Stripe shell init
__STRIPE_SHELLINIT_ZSH_SKIP_COMPINIT=1
if [[ -f ~/.stripe/shellinit/zshrc ]]; then
  source ~/.stripe/shellinit/zshrc
fi

# Chef-managed aliases
alias tc='/usr/local/stripe/bin/test_cookbook'
alias cz='/usr/local/stripe/bin/chef-zero'
alias cookit='tc && cz'
