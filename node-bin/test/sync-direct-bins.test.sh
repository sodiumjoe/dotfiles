#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/sync-direct-bins.XXXXXX")"
trap 'rm -rf "$tmpdir"' EXIT

mkdir -p "$tmpdir/project/node_modules/direct-object" \
  "$tmpdir/project/node_modules/direct-string" \
  "$tmpdir/project/node_modules/@scope/scoped-string" \
  "$tmpdir/project/node_modules/transitive-object" \
  "$tmpdir/project/bin"

cat >"$tmpdir/project/package.json" <<'JSON'
{
  "private": true,
  "dependencies": {
    "direct-object": "1.0.0",
    "direct-string": "1.0.0",
    "@scope/scoped-string": "1.0.0"
  }
}
JSON

cat >"$tmpdir/project/node_modules/direct-object/package.json" <<'JSON'
{
  "name": "direct-object",
  "bin": {
    "direct-object": "cli.js",
    "direct-tool": "tool.js"
  }
}
JSON

cat >"$tmpdir/project/node_modules/direct-string/package.json" <<'JSON'
{
  "name": "direct-string",
  "bin": "cli.js"
}
JSON

cat >"$tmpdir/project/node_modules/@scope/scoped-string/package.json" <<'JSON'
{
  "name": "@scope/scoped-string",
  "bin": "cli.js"
}
JSON

cat >"$tmpdir/project/node_modules/transitive-object/package.json" <<'JSON'
{
  "name": "transitive-object",
  "bin": {
    "transitive-object": "cli.js"
  }
}
JSON

touch "$tmpdir/project/node_modules/direct-object/cli.js" \
  "$tmpdir/project/node_modules/direct-object/tool.js" \
  "$tmpdir/project/node_modules/direct-string/cli.js" \
  "$tmpdir/project/node_modules/@scope/scoped-string/cli.js" \
  "$tmpdir/project/node_modules/transitive-object/cli.js" \
  "$tmpdir/project/bin/stale"

node "$repo_root/node-bin/sync-direct-bins.mjs" "$tmpdir/project"

test -L "$tmpdir/project/bin/direct-object"
test -L "$tmpdir/project/bin/direct-tool"
test -L "$tmpdir/project/bin/direct-string"
test -L "$tmpdir/project/bin/scoped-string"
test ! -e "$tmpdir/project/bin/transitive-object"
test ! -e "$tmpdir/project/bin/stale"

test "$(readlink "$tmpdir/project/bin/direct-object")" = "../node_modules/direct-object/cli.js"
test "$(readlink "$tmpdir/project/bin/direct-tool")" = "../node_modules/direct-object/tool.js"
test "$(readlink "$tmpdir/project/bin/direct-string")" = "../node_modules/direct-string/cli.js"
test "$(readlink "$tmpdir/project/bin/scoped-string")" = "../node_modules/@scope/scoped-string/cli.js"
