#!/usr/bin/env bash
set -euo pipefail
here=$(cd -- "$(dirname -- "$0")" && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT HUP INT TERM
source_root=$temporary/source
mkdir -p "$source_root/usr/libexec/git-core" "$temporary/output"
for name in git-daemon git-imap-send git-http-backend git-remote-http; do
  printf 'fixture %s\n' "$name" >"$source_root/usr/libexec/git-core/$name"
done
ln "$source_root/usr/libexec/git-core/git-remote-http" \
  "$source_root/usr/libexec/git-core/git-remote-https"
ln -s git-remote-http "$source_root/usr/libexec/git-core/client-alias"
printf 'untouched\n' >"$source_root/line"$'\n'"break"

# The raw checkpoint is deliberately red for the current profile.
test -f "$source_root/usr/libexec/git-core/git-daemon"
bash "$here/prepare-package-payload.sh" "$source_root" \
  "$temporary/output/git" >"$temporary/projection.log"
grep -qxF 'package payload profile: git (3 omitted coordinates)' \
  "$temporary/projection.log"
for name in git-daemon git-imap-send git-http-backend; do
  test -f "$source_root/usr/libexec/git-core/$name"
  test ! -e "$temporary/output/git/usr/libexec/git-core/$name"
done
for name in git-remote-http git-remote-https; do
  target=$temporary/output/git/usr/libexec/git-core/$name
  cmp "$source_root/usr/libexec/git-core/$name" "$target"
  test "$target" -ef "$source_root/usr/libexec/git-core/$name"
done
test "$(readlink "$temporary/output/git/usr/libexec/git-core/client-alias")" = git-remote-http
cmp "$source_root/line"$'\n'"break" "$temporary/output/git/line"$'\n'"break"

# Already-clean checkpoints converge to the identical package bytes.
bash "$here/prepare-package-payload.sh" "$temporary/output/git" \
  "$temporary/output/clean" >"$temporary/clean.log"
grep -qxF 'package payload profile: clean (0 omitted coordinates)' \
  "$temporary/clean.log"
diff -r "$temporary/output/git" "$temporary/output/clean"
if bash "$here/prepare-package-payload.sh" "$source_root" \
    "$source_root/nested" >/dev/null 2>&1; then
  printf 'package projection accepted a destination inside its owner\n' >&2
  exit 1
fi
if bash "$here/prepare-package-payload.sh" "$source_root" \
    "$temporary/output/git" >/dev/null 2>&1; then
  printf 'package projection overwrote an existing checkpoint\n' >&2
  exit 1
fi
services=$temporary/services
mkdir -p "$services/var"
ln -s ../run "$services/var/run"
bash "$here/prepare-package-payload.sh" "$services" "$temporary/output/base-services" >/dev/null
test -d "$temporary/output/base-services/run"
test ! -L "$temporary/output/base-services/run"
test "$(stat -c %a "$temporary/output/base-services/run")" = 755
test "$(realpath -e "$temporary/output/base-services/var/run")" = "$temporary/output/base-services/run"
test ! -e "$services/run"
for conflict in file symlink; do
  mkdir -p "$temporary/$conflict/var" "$temporary/$conflict-out"
  ln -s ../run "$temporary/$conflict/var/run"
  if [[ $conflict == file ]]; then printf 'occupied\n' >"$temporary/$conflict/run";
  else ln -s / "$temporary/$conflict/run"; fi
  if bash "$here/prepare-package-payload.sh" "$temporary/$conflict" "$temporary/$conflict-out/base-services" >/dev/null 2>&1; then
    printf 'package payload accepted a conflicting run mountpoint\n' >&2; exit 1
  fi
done
printf 'package payload profile: green (old checkpoint, owner sharing, idempotence, signed run mountpoint)\n'
