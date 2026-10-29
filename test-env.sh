#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
output_root=$(mktemp -d)
trap 'rm -rf "$output_root"' EXIT

DOTFILES_ENV=work home/bin/dotfiles-generate --reset --out "$output_root" >/dev/null
[[ -s "$output_root/.claude/CLAUDE.md" && -s "$output_root/.codex/AGENTS.md" ]]
printf '{"runtime": true}\n' > "$output_root/.claude/settings.json"
printf 'model = "runtime-model"\n' > "$output_root/.codex/config.toml"
DOTFILES_ENV=work home/bin/dotfiles-generate --out "$output_root" >/dev/null
python3 - "$output_root" <<'CHECK'
import pathlib, sys
root = pathlib.Path(sys.argv[1])
assert (root / '.claude/settings.json').read_text() == '{"runtime": true}\n'
assert (root / '.codex/config.toml').read_text() == 'model = "runtime-model"\n'
CHECK
DOTFILES_ENV=home home/bin/dotfiles-generate --out "$output_root" >/dev/null
[[ ! -e "$output_root/.codex/config.toml" && ! -e "$output_root/.codex/AGENTS.md" ]]
echo "Generation workflow passed"
python3 test-home-reconcile.py
python3 test-bootstrap.py