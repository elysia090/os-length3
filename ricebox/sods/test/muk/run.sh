#!/bin/sh
# muk on this Linux: muk's own corpus (../../../muk/test/muk.sh, hostile.sh), run whole inside sods. The same C muk
# that runs on Linux is translated and makes each box here, by the calls it makes there (clone into namespaces,
# open_tree and move_mount, pivot_root, the mounts, a terminal of the box's own, the filter), and each box says of
# itself what it says there.
#
#   sh ricebox/sods/test/muk/run.sh BUSYBOX [muk.sh|hostile.sh]...
#
# BUSYBOX: a static x86-64 busybox (the shell and the tools the corpus is written in; a distribution's
# busybox-static is one). Everything else is made here: muk and what its tests run, natively, as they are made
# for Linux; then a root holding them, the corpus and muk's sources (which the corpus reads); and the corpus is
# run in it by sods' kernel, as root of its first namespaces. The corpus makes muk and its probe itself, by
# toolchain/build.sh: here that is a script that hands over what was made, there being no compiler in the root.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
sods=$(cd "$here/../.." && pwd)
ricebox=$(cd "$sods/.." && pwd)
[ "$#" -ge 1 ] || { echo "usage: run.sh BUSYBOX [muk.sh|hostile.sh]..." >&2; exit 2; }
busybox=$1; shift
[ "$#" -ge 1 ] || set -- muk.sh hostile.sh
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/bin" "$root/prebuilt" "$root/repo/ricebox/toolchain" "$root/repo/ricebox/muk"
cp "$busybox" "$root/bin/busybox"
for applet in $("$busybox" --list); do [ "$applet" = busybox ] || ln -s busybox "$root/bin/$applet"; done
sh "$ricebox/toolchain/build.sh" "$ricebox/muk/src/muk.c" "$root/prebuilt/muk"
for unit in probe console; do sh "$ricebox/toolchain/build.sh" "$ricebox/muk/test/$unit.c" "$root/prebuilt/$unit"; done
cp -R "$ricebox/muk/test" "$ricebox/muk/src" "$root/repo/ricebox/muk/"
cat > "$root/repo/ricebox/toolchain/build.sh" <<'SH'
#!/bin/sh
# In place of the compiler: what was made of each source before this root was.
cp "/prebuilt/$(basename "$1" .c)" "$2"
SH
cargo build -q --locked --release --manifest-path "$sods/Cargo.toml"
cargo build -q --locked --release --target wasm32-unknown-unknown --lib --manifest-path "$sods/Cargo.toml"
status=0
for script in "$@"; do
  if node "$sods/runtime/run.ts" --root "$root" --cwd / /bin/sh "/repo/ricebox/muk/test/$script" /prebuilt/muk < /dev/null; then echo "ok   muk on sods: $script"
  else echo "FAIL muk on sods: $script"; status=1; fi
done
exit $status
