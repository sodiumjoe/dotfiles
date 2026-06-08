_sodium_first_existing_dir() {
  local dir

  for dir in "$@"; do
    [[ -d "$dir" ]] || continue
    print -r -- "$dir"
    return 0
  done

  return 1
}

_sodium_define_stripe_named_dirs() {
  local pay_root

  pay_root="$(_sodium_first_existing_dir "$@")" || return 0
  hash -d pay="$pay_root"

  if [[ -d "$pay_root/manage/frontend" ]]; then
    hash -d dashboard="$pay_root/manage/frontend"
  fi
}
