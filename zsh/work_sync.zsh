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
  _devbox_ssh "$host" "$remote_cmd"
}

_devbox_control_path() {
  local control_dir="$HOME/.ssh/devbox-control"

  mkdir -p "$control_dir" || return
  chmod 700 "$control_dir" || return
  print -r -- "$control_dir/%C"
}

_devbox_ssh() {
  local control_path
  control_path="$(_devbox_control_path)" || return
  ssh -o ControlMaster=auto -o ControlPersist=60 -o ControlPath="$control_path" "$@"
}

_devbox_branch() {
  local remote_name="$1"
  print -r -- "${SODIUM_REMOTE_BRANCH_PREFIX:-moon}/$remote_name"
}

_devbox_host_for_remote() {
  local remote_name="$1"
  pay remote list --raw | jq -er --arg name "$remote_name" '.[] | select(.name == $name) | .host'
}

_devbox_status_for_remote() {
  local remote_name="$1"
  pay remote list --raw | jq -er --arg name "$remote_name" '.[] | select(.name == $name) | .status'
}

_devbox_start_if_needed() {
  local remote_name="$1"
  local remote_status

  remote_status="$(_devbox_status_for_remote "$remote_name")" || return
  [[ "$remote_status" == "running" ]] && return 0

  pay remote start "$remote_name"
}

_devbox_attach_tmux() {
  local host="$1"
  local control_template
  local control_path

  control_template="$(_devbox_control_path)" || return
  control_path=$(ssh -G -o ControlPath="$control_template" "$host" 2>/dev/null |
    awk '$1 == "controlpath" { print $2; exit }') || return
  [[ -n "$control_path" ]] || return
  if [[ -n "${TMUX_PANE:-}" ]]; then
    tmux set-option -p -t "$TMUX_PANE" @remote_host "$host" 2>/dev/null || true
    tmux set-option -p -t "$TMUX_PANE" @remote_control_path "$control_path" 2>/dev/null || true
  fi

  ssh \
    -o ControlMaster=auto \
    -o ControlPersist=60 \
    -o ControlPath="$control_path" \
    -t "$host" "/usr/bin/tmux a || /usr/bin/tmux"
}

_devbox_remote_home() {
  local host="$1"
  _devbox_ssh "$host" 'printf "%s\n" "$HOME"'
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

_devbox_filter_sync_output() {
  perl -0pe 's/^Warning: No archive files were found for these roots, whose canonical names are:
(?:\t[^\n]+\n)+This can happen either
because this is the first time you have synchronized these roots,[ \t]*
or because you have upgraded Unison to a new version with a different
archive format\.[ \t]*

Update detection may take a while on this run if the replicas are[ \t]*
large\.

Unison will assume that the \x27last synchronized state\x27 of both replicas
was completely empty\.  This means that any files that are different
will be reported as conflicts, and any files that exist only on one
replica will be judged as new and propagated to the other replica\.
If the two replicas are identical, then no changes will be reported\.

If you see this message repeatedly, it may be because one of your machines
is getting its address from DHCP, which is causing its host name to change
between synchronizations\.  See the documentation for the UNISONLOCALHOSTNAME
environment variable for advice on how to correct this\.\n*//mg'
}

_devbox_sync() {
  setopt localoptions pipefail
  local host="$1"
  local remote_work_uri
  local control_path

  _devbox_sync_preflight "$host" || return
  remote_work_uri="$(_devbox_remote_work_uri "$host")" || return
  control_path="$(_devbox_control_path)" || return
  _devbox_ssh "$host" 'mkdir -p "$HOME/stripe/work"' || return
  unison ~/stripe/work/ "$remote_work_uri" \
    -batch -copyonconflict -fastcheck true -silent \
    -sshargs "-o ControlMaster=auto -o ControlPersist=60 -o ControlPath=${(q)control_path}" \
    -ignore 'Name .DS_Store' \
    -ignore 'Name *.jsonl' \
    -ignore 'Name .obsidian' \
    -ignore 'Name node_modules' \
    -logfile /tmp/unison-sync-${host}.log \
    2>&1 | _devbox_filter_sync_output
}

_devbox_sync_loop() {
  local host="$1"
  local remote_work_uri
  local control_path

  _devbox_sync_loop_stop "$host"
  _devbox_sync_preflight "$host" || return
  remote_work_uri="$(_devbox_remote_work_uri "$host")" || return
  control_path="$(_devbox_control_path)" || return
  unison ~/stripe/work/ "$remote_work_uri" \
    -batch -copyonconflict -fastcheck true -silent \
    -sshargs "-o ControlMaster=auto -o ControlPersist=60 -o ControlPath=${(q)control_path}" \
    -repeat 5 \
    -ignore 'Name .DS_Store' \
    -ignore 'Name *.jsonl' \
    -ignore 'Name .obsidian' \
    -ignore 'Name node_modules' \
    -logfile /tmp/unison-sync-${host}.log \
    &>/dev/null &
  echo $! >| /tmp/unison-sync-${host}.pid
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
