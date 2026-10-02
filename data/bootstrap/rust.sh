#!/usr/bin/env bash
set -euo pipefail

# A separately locked build-only tool closure. Installing it must not change
# the bootstrap compiler or invalidate unrelated native object checkpoints.
here=$(cd -- "$(dirname -- "$0")" && pwd)
repo=$(cd -- "$here/../.." && pwd)
[[ $(uname -sm) == 'Linux x86_64' && -f /etc/alpine-release ]]
[[ $(uname -r) != *[Mm]icrosoft* && $(uname -r) != *WSL* ]]
work=$repo/temp/bootstrap-rust
cache=$repo/data/upstream/bootstrap/rust-packages
bootstrap_cache=${QM_BOOTSTRAP_WORK:-/build/bootstrap}/packages
mode=${1:-install}
shift || true
mkdir -p "$work" "$cache"

if [[ $mode == resolve ]]; then
  # Only this explicit maintenance action resolves repository dependencies.
  mapfile -t packages < "$here/rust.world"
  apk --repositories-file "$here/repositories" fetch --recursive \
    --output "$cache" "${packages[@]}" >&2
  apk verify "$cache"/*.apk >&2
  (cd "$cache" && sha256sum ./*.apk | LC_ALL=C sort -k2) > "$work/rust.sha256"
  manifest=$work/rust.sha256
else
  manifest=$here/rust.sha256
fi
[[ -s $manifest ]]
identity=$(sha256sum "$manifest" | cut -d' ' -f1)
root=$work/roots/$identity
files=()
while read -r digest name extra; do
  [[ $digest =~ ^[0-9a-f]{64}$ && $name =~ ^\./[A-Za-z0-9_.+-]+\.apk$ && -z ${extra:-} ]]
  candidate=$cache/${name#./}
  # A build-only package may already be retained by the pinned base host.
  # Verify the rust closure's own digest before sharing those exact bytes;
  # neither cache is an authority merely because a filename matches.
  if [[ $mode != resolve && ! -f $candidate \
      && -f $bootstrap_cache/${name#./} ]]; then
    candidate=$bootstrap_cache/${name#./}
  fi
  printf '%s  %s\n' "$digest" "$candidate" | sha256sum --check --status
  files+=("$candidate")
done < "$manifest"
[[ ${#files[@]} -gt 0 ]]
case $mode in
  install|resolve)
    mkdir -p "$root"
    apk --root "$root" --initdb --keys-dir /etc/apk/keys --no-network \
      --no-scripts --repositories-file /dev/null add "${files[@]}" >&2
    awk '/^P:/ { p=substr($0,3) } /^V:/ { print p "=" substr($0,3) }' \
      "$root/lib/apk/db/installed" | LC_ALL=C sort > "$work/rust-installed.lock"
    if [[ $mode == install ]]; then
      cmp "$here/rust-installed.lock" "$work/rust-installed.lock"
    fi
    printf '%s\n' "$identity" > "$root/.verified"
    printf '%s\n' "$root"
    ;;
  run)
    [[ -f $root/.verified && $(<"$root/.verified") == "$identity" ]]
    awk '/^P:/ { p=substr($0,3) } /^V:/ { print p "=" substr($0,3) }' \
      "$root/lib/apk/db/installed" | LC_ALL=C sort | cmp -s "$here/rust-installed.lock" -
    # The compiler finds its sysroot beside its own executable. Only this
    # process receives the tool's library path; the host package DB is intact.
    export PATH="$root/usr/bin:$PATH" LD_LIBRARY_PATH="$root/usr/lib"
    export CARGO_HOME="$work/cargo-home" CARGO_NET_OFFLINE=true
    exec "$@"
    ;;
  *) printf 'usage: rust.sh [install|resolve|run command...]\n' >&2; exit 2;;
esac
