#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
umask 022
here=$(cd -- "$(dirname -- "$0")" && pwd)
tool=$here/../../src/v2/artifact/build/artifact-measure-namespace
[[ $(id -u) == 0 ]] || { printf 'fixture requires root for uid/gid cases\n' >&2; exit 2; }
command -v rsync >/dev/null
temporary_parent=$(realpath -e -- "${TMPDIR:-/tmp}")
temporary=$(mktemp -d -- "$temporary_parent/package-set-fixtures.XXXXXXXX")
created=$(realpath -e -- "$temporary")
cleanup() {
  [[ -d $temporary && $(realpath -e -- "$temporary") == "$created"
     && $(dirname -- "$created") == "$temporary_parent" ]] || return
  rm -rf -- "$temporary"
}
trap cleanup EXIT HUP INT TERM
alpha=$temporary/alpha; beta=$temporary/beta; output=$temporary/output
mkdir -p "$alpha/usr/bin" "$beta/usr/share"
printf abc >"$alpha/usr/bin/tool"
chmod 0644 "$alpha/usr/bin/tool"
ln "$alpha/usr/bin/tool" "$alpha/usr/bin/alias"
ln -s usr/bin/tool "$alpha/link"
printf qwe >"$beta/usr/share/data"
printf 'preserved work difference\n' >"$temporary/work-diff"
work_sha=$(sha256sum "$temporary/work-diff" | cut -d' ' -f1)
manifest=$(bash "$here/emit-package-set.sh" "$temporary/manifests" fixture one "alpha:$alpha" "beta:$beta")
bash "$here/assemble-package-set.sh" "$manifest" "$output" >/dev/null
marker=$output.package-set
baseline=$("$tool" --identity "$output")
marker_sha=$(sha256sum "$marker" | cut -d' ' -f1)
cases=1
expect_reuse() {
  local inode
  inode=$(stat -c '%d:%i' "$output")
  bash "$here/assemble-package-set.sh" "$manifest" "$output" >/dev/null
  [[ $(stat -c '%d:%i' "$output") == "$inode"
     && $("$tool" --identity "$output") == "$baseline"
     && $(sha256sum "$marker" | cut -d' ' -f1) == "$marker_sha" ]]
  cases=$((cases+1))
}
expect_reject() {
  local before_output before_marker before_manifest before_binding
  before_output=$("$tool" --identity "$output")
  before_marker=$(sha256sum "$marker" | cut -d' ' -f1)
  before_manifest=$(sha256sum "$manifest" | cut -d' ' -f1)
  before_binding=$(sha256sum "$manifest.content" | cut -d' ' -f1)
  if bash "$here/assemble-package-set.sh" "$manifest" "$output" >"$temporary/rejection" 2>&1; then
    printf 'unexpected cache acceptance\n' >&2; exit 1
  fi
  [[ $("$tool" --identity "$output") == "$before_output"
     && $(sha256sum "$marker" | cut -d' ' -f1) == "$before_marker"
     && $(sha256sum "$manifest" | cut -d' ' -f1) == "$before_manifest"
     && $(sha256sum "$manifest.content" | cut -d' ' -f1) == "$before_binding"
     && $(sha256sum "$temporary/work-diff" | cut -d' ' -f1) == "$work_sha" ]]
  cases=$((cases+1))
}
expect_reuse
manifest_inode=$(stat -c '%d:%i' "$manifest")
test "$(bash "$here/emit-package-set.sh" "$temporary/manifests" fixture one "alpha:$alpha" "beta:$beta")" = "$manifest"
test "$(stat -c '%d:%i' "$manifest")" = "$manifest_inode"
cases=$((cases+1))
printf abd >"$alpha/usr/bin/tool"; expect_reject; printf abc >"$alpha/usr/bin/tool"
# The later package used to be linked directly from its caller-owned root.
printf qwx >"$beta/usr/share/data"
test "$("$tool" --identity "$output")" = "$baseline"
expect_reject; printf qwe >"$beta/usr/share/data"
chmod 0755 "$alpha/usr/bin/tool"; expect_reject; chmod 0644 "$alpha/usr/bin/tool"
chown 65534:0 "$alpha/usr/bin/tool"; expect_reject; chown 0:0 "$alpha/usr/bin/tool"
chown 0:65534 "$alpha/usr/bin/tool"; expect_reject; chown 0:0 "$alpha/usr/bin/tool"
rm -- "$alpha/link"; ln -s usr/bin/alias "$alpha/link"; expect_reject
rm -- "$alpha/link"; ln -s usr/bin/tool "$alpha/link"
cp -a -- "$alpha/usr/bin/alias" "$temporary/independent"
rm -- "$alpha/usr/bin/alias"; mv -- "$temporary/independent" "$alpha/usr/bin/alias"; expect_reject
rm -- "$alpha/usr/bin/alias"; ln "$alpha/usr/bin/tool" "$alpha/usr/bin/alias"
python3 - "$alpha/usr/bin/tool" <<'PY'
import os, sys
os.setxattr(sys.argv[1], 'user.contract', b'one')
PY
expect_reject
python3 - "$alpha/usr/bin/tool" <<'PY'
import os, sys
os.removexattr(sys.argv[1], 'user.contract')
PY
touch -d @123456789 "$alpha/usr/bin/tool"; expect_reuse
cp -a -- "$alpha" "$temporary/relocated"
test "$("$tool" --identity "$alpha")" = "$("$tool" --identity "$temporary/relocated")"
cases=$((cases+1))
chmod 0700 "$output"; expect_reject; chmod 0755 "$output"
printf abd >"$output/usr/bin/tool"; expect_reject; printf abc >"$output/usr/bin/tool"
cp -- "$marker" "$temporary/current-marker"
printf '%s\n' "$(sha256sum "$manifest" | cut -d' ' -f1)" >"$marker"
expect_reject; cp -- "$temporary/current-marker" "$marker"
cp -- "$manifest.content" "$temporary/current-binding"
printf 'package-root-content-v1\n%s\nalpha\t%064d\nbeta\t%064d\n' \
  "$(sha256sum "$manifest" | cut -d' ' -f1)" 0 0 >"$manifest.content"
expect_reject; cp -- "$temporary/current-binding" "$manifest.content"
cp -- "$manifest" "$temporary/current-manifest"
printf 'package-root-set-v1\nalpha\t%s\nbeta\t%s\n' "$temporary/relocated" "$beta" >"$manifest"
expect_reject; cp -- "$temporary/current-manifest" "$manifest"
# Old manifests and existing coordinates are retained without automatic sealing.
mv -- "$manifest.content" "$temporary/current-binding"
if bash "$here/assemble-package-set.sh" "$manifest" "$output" >/dev/null 2>&1; then exit 1; fi
if bash "$here/emit-package-set.sh" "$temporary/manifests" fixture one "alpha:$alpha" "beta:$beta" >/dev/null 2>&1; then exit 1; fi
test ! -e "$manifest.content"; test "$("$tool" --identity "$output")" = "$baseline"
mv -- "$temporary/current-binding" "$manifest.content"; cases=$((cases+1))
# Real assembly with a controlled source mutation after snapshot validation.
# Only the fixture's clone wrapper changes; the identity CLI is the real tool.
mkdir -p "$temporary/code/data/distribution" "$temporary/code/src/v2/artifact/build"
cp -- "$here/assemble-package-set.sh" "$here/package-set-content.sh" "$temporary/code/data/distribution/"
ln -s "$(realpath -e -- "$tool")" "$temporary/code/src/v2/artifact/build/artifact-measure-namespace"
printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' \
  'printf xyz >"$PACKAGE_FIXTURE_MUTATION"' \
  'exec bash "$PACKAGE_FIXTURE_REAL_CLONE" "$@"' >"$temporary/code/data/distribution/clone-tree.sh"
PACKAGE_FIXTURE_MUTATION="$alpha/usr/bin/tool" PACKAGE_FIXTURE_REAL_CLONE="$here/clone-tree.sh" \
  bash "$temporary/code/data/distribution/assemble-package-set.sh" "$manifest" "$temporary/race-output" >/dev/null
test "$(cat "$temporary/race-output/usr/bin/tool")" = abc
test "$(cat "$alpha/usr/bin/tool")" = xyz
test "$(cat "$output/usr/bin/tool")" = abc
printf abc >"$alpha/usr/bin/tool"; cases=$((cases+1))
expect_reuse
cp -a -- "$alpha" "$temporary/order-a"
cp -a -- "$alpha" "$temporary/order-b"
python3 - "$temporary/order-a/usr/bin/tool" "$temporary/order-b/usr/bin/tool" <<'PY'
import os, sys
for path, names in [(sys.argv[1], ['user.a', 'user.b']), (sys.argv[2], ['user.b', 'user.a'])]:
    for name in names:
        os.setxattr(path, name, name.encode())
PY
test "$("$tool" --identity "$temporary/order-a")" = "$("$tool" --identity "$temporary/order-b")"
cases=$((cases+1))
printf 'package-set content fixtures: green (%s cases; input cuts, metadata, reuse, drift rejection and preservation)\n' "$cases"
printf 'format=package-set-fixture-acceptance-v1\ncontract=package-root-content-v1\n'
printf 'cases=%s\nuid=%s\numask=022\n' "$cases" "$(id -u)"
printf 'tool.sha256=%s\nfixture.sha256=%s\n' \
  "$(sha256sum "$tool" | cut -d' ' -f1)" \
  "$(sha256sum "$here/check-package-set-content.sh" | cut -d' ' -f1)"
printf 'fixture.output.sha256=%s\nfixture.marker.sha256=%s\n' "$baseline" "$marker_sha"
printf 'scope=isolated-Linux-package-set-fixtures-only\n'
