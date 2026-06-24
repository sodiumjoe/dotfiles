_sodium_first_existing_dir() {
  local dir

  for dir in "$@"; do
    [[ -d "$dir" ]] || continue
    print -r -- "$dir"
    return 0
  done

  return 1
}

_sodium_define_home_named_dir() {
  local name="$1"
  local relative_path="$2"
  local dir

  if [[ -n "${TMUX:-}" ]]; then
    dir="$(_sodium_first_existing_dir \
      "${SODIUM_HOME_MIRROR_ROOT:-/pay}${HOME}/${relative_path}" \
      "${HOME}/${relative_path}")" || return 0
  else
    dir="$(_sodium_first_existing_dir "${HOME}/${relative_path}")" || return 0
  fi

  hash -d "${name}=${dir}"
}

_sodium_define_stripe_named_dirs() {
  local pay_root

  pay_root="$(_sodium_first_existing_dir "$@")" || return 0
  hash -d pay="$pay_root"

  if [[ -d "$pay_root/manage/frontend" ]]; then
    hash -d dashboard="$pay_root/manage/frontend"
  fi
}
