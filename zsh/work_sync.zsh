_work_invalid_project_dirs() {
  local projects_dir="$1"
  local -a invalid_dirs=()
  local dir

  [[ -d "$projects_dir" ]] || return 0

  for dir in "$projects_dir"/*(N/); do
    [[ -f "$dir/project.md" ]] && continue
    invalid_dirs+=("${dir:t}")
  done

  (( ${#invalid_dirs[@]} > 0 )) || return 0
  printf '%s\n' "${invalid_dirs[@]}" | LC_ALL=C sort
}

_devbox_remote_invalid_project_dirs() {
  local host="$1"
  local remote_cmd='projects_dir="$HOME/stripe/work/projects"
[ -d "$projects_dir" ] || exit 0
find "$projects_dir" -mindepth 1 -maxdepth 1 -type d ! -exec test -f "{}/project.md" ";" -exec basename "{}" ";" | LC_ALL=C sort'
  ssh "$host" "$remote_cmd"
}

_devbox_branch() {
  local remote_name="$1"
  print -r -- "${SODIUM_REMOTE_BRANCH_PREFIX:-moon}/$remote_name"
}

_devbox_remote_home() {
  local host="$1"
  ssh "$host" 'printf "%s\n" "$HOME"'
}

_devbox_remote_work_uri() {
  local host="$1"
  local remote_home

  remote_home="$(_devbox_remote_home "$host")" || return
  [[ -n "$remote_home" ]] || return 1
  print -r -- "ssh://${host}/${remote_home}/stripe/work/"
}

_devbox_sync_preflight() {
  local host="$1"
  local local_projects_dir="$HOME/stripe/work/projects"
  local local_invalid=""
  local remote_invalid=""
  local name

  local_invalid="$(_work_invalid_project_dirs "$local_projects_dir")"
  if [[ -n "$local_invalid" ]]; then
    print -u2 -- "devbox sync blocked: local invalid project directories in $local_projects_dir"
    while IFS= read -r name; do
      [[ -n "$name" ]] && print -u2 -- "  $name"
    done <<< "$local_invalid"
    return 1
  fi

  if ! remote_invalid="$(_devbox_remote_invalid_project_dirs "$host")"; then
    print -u2 -- "devbox sync blocked: failed to inspect remote project directories on $host"
    return 1
  fi

  if [[ -n "$remote_invalid" ]]; then
    print -u2 -- "devbox sync blocked: remote invalid project directories on $host"
    while IFS= read -r name; do
      [[ -n "$name" ]] && print -u2 -- "  $name"
    done <<< "$remote_invalid"
    return 1
  fi
}

_devbox_sync() {
  local host="$1"
  local remote_work_uri

  _devbox_sync_preflight "$host" || return
  remote_work_uri="$(_devbox_remote_work_uri "$host")" || return
  ssh "$host" 'mkdir -p "$HOME/stripe/work"' 2>/dev/null
  unison ~/stripe/work/ "$remote_work_uri" \
    -batch -prefer newer -fastcheck true -silent \
    -ignore 'Name .DS_Store' \
    -ignore 'Name *.jsonl' \
    -ignore 'Name .obsidian' \
    -ignore 'Name node_modules' \
    -logfile /tmp/unison-sync-${host}.log
}

_devbox_sync_loop() {
  local host="$1"
  local remote_work_uri

  _devbox_sync_loop_stop "$host"
  _devbox_sync_preflight "$host" || return
  remote_work_uri="$(_devbox_remote_work_uri "$host")" || return
  unison ~/stripe/work/ "$remote_work_uri" \
    -batch -prefer newer -fastcheck true -silent \
    -repeat 5 \
    -ignore 'Name .DS_Store' \
    -ignore 'Name *.jsonl' \
    -ignore 'Name .obsidian' \
    -ignore 'Name node_modules' \
    -logfile /tmp/unison-sync-${host}.log \
    &>/dev/null &
  echo $! > /tmp/unison-sync-${host}.pid
}

_devbox_sync_loop_stop() {
  local host="$1"
  local pidfile="/tmp/unison-sync-${host}.pid"
  if [[ -f "$pidfile" ]]; then
    local pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null
    fi
    rm -f "$pidfile"
  fi
}
