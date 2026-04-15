#!/usr/bin/env bash
# Unit tests for review-submit payload construction.
# Mocks gh api to capture the payload instead of sending it.
set -euo pipefail

script_dir="$(cd "$(dirname "$0")/../scripts" && pwd)"
pass=0
fail=0
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

# Mock gh: dump stdin to a file instead of calling the API
mock_gh="$tmpdir/gh"
cat > "$mock_gh" <<'MOCK'
#!/usr/bin/env bash
if [[ "${1:-}" == "api" ]]; then
  cat > "$GH_PAYLOAD_FILE"
  exit 0
fi
exec /usr/bin/env gh "$@"
MOCK
chmod +x "$mock_gh"

run_submit() {
  local desc="$1"; shift
  local input="$1"; shift
  export GH_PAYLOAD_FILE="$tmpdir/payload.json"
  export PATH="$tmpdir:$PATH"
  rm -f "$GH_PAYLOAD_FILE"
  if echo "$input" | "$script_dir/review-submit" "$@" >"$tmpdir/stdout" 2>"$tmpdir/stderr"; then
    true
  else
    echo "  FAIL: $desc — submit exited non-zero (stderr: $(cat "$tmpdir/stderr"))" >&2
    fail=$((fail + 1))
    return 1
  fi
  cat "$GH_PAYLOAD_FILE"
}

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  PASS: $desc"
    pass=$((pass + 1))
  else
    echo "  FAIL: $desc"
    echo "    expected: $expected"
    echo "    actual:   $actual"
    fail=$((fail + 1))
  fi
}

# --- Test: approval with no comments, no body ---
echo "=== Test: bare approval ==="
payload=$(run_submit "bare approval" "[]" 123 APPROVE)
assert_eq "event is APPROVE" "APPROVE" "$(echo "$payload" | jq -r .event)"
assert_eq "no body field" "null" "$(echo "$payload" | jq -r '.body // "null"')"
assert_eq "no comments field" "null" "$(echo "$payload" | jq -r '.comments // "null"')"

# --- Test: approval with body ---
echo "=== Test: approval with body ==="
payload=$(run_submit "approval+body" "[]" 123 APPROVE "LGTM")
assert_eq "event is APPROVE" "APPROVE" "$(echo "$payload" | jq -r .event)"
assert_eq "body is LGTM" "LGTM" "$(echo "$payload" | jq -r .body)"

# --- Test: comments with ref suffix stripping ---
echo "=== Test: ref suffix stripping ==="
comments='[{"file":"foo.ts (pr-999)","line_start":10,"body":"nit"}]'
payload=$(run_submit "suffix strip" "$comments" 123 COMMENT)
assert_eq "path stripped" "foo.ts" "$(echo "$payload" | jq -r '.comments[0].path')"
assert_eq "line from line_start" "10" "$(echo "$payload" | jq -r '.comments[0].line')"

# --- Test: comments with line_end preferred over line_start ---
echo "=== Test: line_end preference ==="
comments='[{"file":"bar.ts (HEAD)","line_end":20,"line_start":15,"body":"check"}]'
payload=$(run_submit "line_end" "$comments" 123 COMMENT)
assert_eq "line from line_end" "20" "$(echo "$payload" | jq -r '.comments[0].line')"

# --- Test: basename resolution via .review/files ---
echo "=== Test: basename resolution ==="
mkdir -p "$tmpdir/repo/.review"
cat > "$tmpdir/repo/.review/files" <<'FILES'
pay-server/stripethirdparty/config/cdn_security_headers.yaml
pay-server/stripethirdparty/src/entries/AlgoliaSearch/AlgoliaSearch.ts
FILES
comments='[{"file":"pay-server/AlgoliaSearch.ts (pr-123)","line_start":22,"body":"fix"},{"file":"pay-server/cdn_security_headers.yaml (pr-123)","line_start":29,"body":"why"}]'
payload=$(run_submit "basename resolve" "$comments" 123 APPROVE "" "$tmpdir/repo")
assert_eq "AlgoliaSearch resolved" \
  "pay-server/stripethirdparty/src/entries/AlgoliaSearch/AlgoliaSearch.ts" \
  "$(echo "$payload" | jq -r '.comments[0].path')"
assert_eq "yaml resolved" \
  "pay-server/stripethirdparty/config/cdn_security_headers.yaml" \
  "$(echo "$payload" | jq -r '.comments[1].path')"
assert_eq "has 2 comments" "2" "$(echo "$payload" | jq '.comments | length')"

# --- Test: null line filtered out ---
echo "=== Test: null line filtered ==="
comments='[{"file":"ok.ts","line_start":5,"body":"good"},{"file":"bad.ts","body":"no line"}]'
payload=$(run_submit "null line" "$comments" 123 COMMENT)
assert_eq "only 1 comment" "1" "$(echo "$payload" | jq '.comments | length')"
assert_eq "kept comment with line" "ok.ts" "$(echo "$payload" | jq -r '.comments[0].path')"

# --- Test: comments with no body omits body from payload ---
echo "=== Test: comments without body ==="
comments='[{"file":"x.ts","line_start":1,"body":"note"}]'
payload=$(run_submit "no body" "$comments" 123 APPROVE)
assert_eq "no body field" "null" "$(echo "$payload" | jq -r '.body // "null"')"
assert_eq "event is APPROVE" "APPROVE" "$(echo "$payload" | jq -r .event)"
assert_eq "has comments" "1" "$(echo "$payload" | jq '.comments | length')"

# --- Summary ---
echo ""
echo "Results: $pass passed, $fail failed"
[[ $fail -eq 0 ]]