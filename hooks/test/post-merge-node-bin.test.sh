#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/post-merge-node-bin.XXXXXX")"
trap 'rm -rf "$tmpdir"' EXIT

git_init() {
  git init -q
  git config user.name "Test User"
  git config user.email "test@example.com"
  git config core.fsmonitor false
}

assert_log_contains() {
  local expected="$1"

  if ! grep -qxF "$expected" "$tmpdir/npm.log"; then
    echo "missing npm command: $expected" >&2
    echo "actual npm commands:" >&2
    cat "$tmpdir/npm.log" >&2
    exit 1
  fi
}

mkdir -p "$tmpdir/repo/bin" "$tmpdir/repo/node-bin" "$tmpdir/bin"
cd "$tmpdir/repo"
git_init

cat >bin/dotfiles-diff <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x bin/dotfiles-diff

cat >bin/dotfiles-generate <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x bin/dotfiles-generate

cat >"$tmpdir/bin/npm" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$tmpdir/npm.log"
EOF
chmod +x "$tmpdir/bin/npm"
: >"$tmpdir/npm.log"

printf '{}\n' >node-bin/package-lock.json
git add .
git commit -qm initial
before="$(git rev-parse HEAD)"

printf '{"changed":true}\n' >node-bin/package-lock.json
git add node-bin/package-lock.json
git commit -qm "change node-bin lock"
git update-ref ORIG_HEAD "$before"

PATH="$tmpdir/bin:$PATH" bash "$repo_root/hooks/post-merge"

assert_log_contains "ci --prefix node-bin"
assert_log_contains "run sync-bins --prefix node-bin"
