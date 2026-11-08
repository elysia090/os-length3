#!/bin/sh
# What the root's Rust and Go programs are made of, against the advisories published of it: each one's lockfile
# (Cargo.lock; go.mod), taken from the very archive its pin names and checked against the pin's digest, with what its
# recipe lifts past advisories taken as the builder takes it (lift.sh: cargo update, go get), asked of OSV
# (osv-scanner: RustSec's advisories and Go's vulnerability database among them). A Go program's standard library is
# the one it is built with, the build machine's Go (Alpine's, at the version root/make/build.sh's Alpine has: root/make/next.py
# finds it), not the version its go.mod asks for at least: that Go is asked of OSV itself, by its version (osv-scanner
# matches the standard library by go.mod's version, whatever it is told the toolchain is). An advisory that is known
# and does not reach the root, or has nothing to raise to yet, is named in root/pins/advisories.toml with why, and until
# when.
#
#   sh root/make/advisories.sh [OSV-SCANNER]
#
# Fails when one is known to be vulnerable, saying which, by what, and fixed where. (The root's C is not in it: its
# makers' advisories carry no versions OSV knows them by. What fixes them comes with each newer pin, root/make/next.py, and
# the security fixes Alpine carries, which its recipes take.)
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
scanner=${1:-osv-scanner}
. "$here/pins/sources.env"
work=$(mktemp -d "${TMPDIR:-/tmp}/length3-advisories.XXXXXX")
# (Go keeps the modules it fetches read-only: they are made writable again to be removed.)
trap 'chmod -R u+w "${work:?}" 2>/dev/null; rm -rf "${work:?}"' EXIT

. "$here/make/lift.sh"
export CARGO_HOME="$work/cargo" GOPATH="$work/go" GOMODCACHE="$work/go/mod"
set --
for recipe in "$here"/packages/*/recipe.sh; do
  pin=$(pins=; . "$recipe"; echo "${pins%% *}")
  [ -n "$pin" ] || continue
  url=$(eval "echo \"\${${pin}_URL}\"")
  case $url in https://static.crates.io/crates/*.crate|https://proxy.golang.org/*.zip) ;; *) continue ;; esac
  sum=$(eval "echo \"\${${pin}_SHA256}\"")
  f="$work/$pin.archive"
  curl -fsSL --retry 4 -o "$f" "$url"
  echo "$sum  $f" | sha256sum -c - >/dev/null 2>&1 || { echo "advisories: $url is not the file $pin is pinned at" >&2; exit 1; }
  mkdir "$work/$pin"
  case $url in
    *.crate) tar -xzf "$f" -C "$work/$pin" --strip-components=1; lock=Cargo.lock ;;
    *.zip)
      # A module's zip has the module and its version as its top (path@version/).
      top=$(unzip -Z1 "$f" | head -n 1 | sed -n 's|^\([^@]*@[^/]*\)/.*|\1|p')
      unzip -q "$f" -d "$work/$pin.zip" && cp -a "$work/$pin.zip/$top/." "$work/$pin/"; lock=go.mod ;;
  esac
  lifts=$(lifts=; . "$recipe"; echo "$lifts")
  (cd "$work/$pin" && for l in $lifts; do lift "$l"; done)
  set -- "$@" -L "$work/$pin/$lock"
done
[ "$#" -gt 0 ] || { echo "advisories: no Rust or Go program is pinned in $here/pins/sources.env" >&2; exit 1; }

# The Go every Go program is built with: its standard library's advisories, as OSV has them for that version.
go=$(cd "$here/make" && python3 -c 'import next; print(next.alpine("go", "community"))')
stdlib=$(curl -fsS --retry 4 -X POST https://api.osv.dev/v1/query \
  -d "{\"package\": {\"name\": \"stdlib\", \"ecosystem\": \"Go\"}, \"version\": \"$go\"}" |
  python3 -c 'import json, sys; print(" ".join(v["id"] for v in json.load(sys.stdin).get("vulns", [])))')
failed=0
if [ -n "$stdlib" ]; then echo "advisories: Go $go, which the Go programs are built with: $stdlib" >&2; failed=1; fi

echo "advisories: $(($# / 2)) lockfiles of the root's Rust and Go programs; Go $go" >&2
"$scanner" scan source --config "$here/pins/advisories.toml" ${OSV_FORMAT:+--format "$OSV_FORMAT"} "$@" || failed=1
exit "$failed"
