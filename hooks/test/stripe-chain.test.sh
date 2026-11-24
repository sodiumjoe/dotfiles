#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/stripe-chain.XXXXXX")"
trap 'rm -rf "$tmpdir"' EXIT

stripe="$tmpdir/stripe"
mkdir -p "$stripe" "$tmpdir/repo/home/bin"
for name in pre-commit commit-msg post-merge; do
  cat >"$stripe/$name" <<EOF
#!/usr/bin/env bash
echo $name >> "$tmpdir/ran.log"
if [ "$name" = pre-commit ] && [ -e .git/hooks/pre-commit ]; then .git/hooks/pre-commit "\$@"; fi
exit 0
EOF
  chmod +x "$stripe/$name"
done

cd "$tmpdir/repo"
git init -q
git config user.name "Test User"
git config user.email "test@example.com"
git config core.fsmonitor false
cp -R "$repo_root/hooks" hooks
rm -rf hooks/test
git config core.hooksPath hooks
mkdir -p .git/hooks
ln -s ../../hooks/pre-commit .git/hooks/pre-commit

for script in dotfiles-generate dotfiles-diff; do
  printf '#!/usr/bin/env bash\nexit 0\n' >"home/bin/$script"
done
printf '#!/usr/bin/env bash\necho reconcile >> "%s/ran.log"\n' "$tmpdir" >home/bin/dotfiles-reconcile
chmod +x home/bin/*
export DOTFILES_STRIPE_HOOKS="$stripe" DOTFILES_ENV=work

git add -A
timeout 30 git commit -q -m initial
if [ "$(grep -c '^pre-commit$' "$tmpdir/ran.log")" != 1 ] || [ "$(grep -c '^commit-msg$' "$tmpdir/ran.log")" != 1 ]; then
  echo "expected Stripe pre-commit and commit-msg to run once each:" >&2
  cat "$tmpdir/ran.log" >&2
  exit 1
fi

: >"$tmpdir/ran.log"
git checkout -q -b feature
echo note >home/new-file
git add home/new-file
DOTFILES_STRIPE_HOOKS="$tmpdir/none" git commit -q -m add
git checkout -q -
timeout 30 git merge -q --ff-only feature >/dev/null
if [ "$(tr '\n' ' ' <"$tmpdir/ran.log")" != "post-merge reconcile " ]; then
  echo "expected Stripe post-merge, then reconcile:" >&2
  cat "$tmpdir/ran.log" >&2
  exit 1
fi

echo "stripe-chain: ok"