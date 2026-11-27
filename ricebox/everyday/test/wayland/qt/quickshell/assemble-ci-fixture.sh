#!/usr/bin/env bash
# Reviewed preflight only: compile, inspect and compare. The caller owns the private work directory.
set -euo pipefail
test "$#" = 2
work=$1 sources=$2
wayland=ricebox/everyday/test/wayland
q=$wayland/qt/quickshell
export LC_ALL=C SOURCE_DATE_EPOCH=0 CARGO_INCREMENTAL=0

test -f "$work/keyring.gpg"
test -d "$work/inputs/catalogs"
test -d "$work/inputs/debs"

# Read just the pinned layer-shell XML from Alpine's versioned package; do not install it.
apk=$work/wlr-protocols.apk
xml=$work/wlr-layer-shell-unstable-v1.xml
url=https://dl-cdn.alpinelinux.org/alpine/v3.24/community/x86_64/wlr-protocols-0_git20250702-r0.apk
code=$(curl --disable --fail --silent --show-error --proto '=https' \
  --connect-timeout 8 --max-time 15 --retry 2 --retry-delay 1 --retry-max-time 30 \
  --max-filesize 24714 --output "$apk" --write-out '%{http_code}' -- "$url")
test "$code" = 200
test "$(wc -c < "$apk")" = 24714
printf '%s  %s\n' 6017705dfd18698ea4b24c1adce8541747eb002f59307758b752f3804a2f205f "$apk" | sha256sum --check --strict
gzip -dc "$apk" | tar --ignore-zeros --warning=no-unknown-keyword -xOf - \
  usr/share/wlr-protocols/unstable/wlr-layer-shell-unstable-v1.xml > "$xml"
EVERYDAY_WLR_LAYER_XML="$xml" sh "$wayland/build.sh" scanner "$sources" "$work/wayland"
CC=musl-gcc EVERYDAY_WITH_QUICKSHELL_POINTER=1 sh "$wayland/build.sh" guest "$sources" "$work/wayland"

printf 'Fixture tools: Node %s; %s\n' "$(node --version)" "$(rustc --version)"
cargo build --locked --release --lib --features mapped-code --target wasm32-unknown-unknown \
  --manifest-path ricebox/sods/Cargo.toml --target-dir "$work/sods-target"
sods=$work/sods-target/wasm32-unknown-unknown/release/sods.wasm
muk=$work/muk
sh ricebox/toolchain/build.sh ricebox/muk/src/muk.c "$muk"
sha() { local hash; hash=$(sha256sum -- "$1"); printf '%s' "${hash%% *}"; }
sods_sha=$(sha "$sods")
muk_sha=$(sha "$muk")

# Pack twice from the authenticated inputs and the same independently recorded tool bytes.
# These digests identify this run only, not a reusable cache or cross-toolchain guarantee.
for output in staged repeat; do
  python3 -B "$q/stage-browser-fixture.py" "$work/inputs/catalogs" "$work/inputs/debs" \
    "$sods" "$muk" "$work/$output" --keyring "$work/keyring.gpg" \
    --sods-sha256 "$sods_sha" --muk-sha256 "$muk_sha"
done
diff -qr "$work/staged" "$work/repeat"
listener_sha=$(sha "$work/wayland/wayland-quickshell-pointer-listener")
qml_sha=$(sha "$q/pointer.qml")
printf 'QUICKSHELL_FIXTURE_ASSEMBLED revision=%s index_sha256=%s sods_sha256=%s muk_sha256=%s listener_sha256=%s pointer_qml_sha256=%s\n' \
  "$(git rev-parse HEAD)" "$(cat "$work/staged/index-sha256.txt")" "$sods_sha" "$muk_sha" "$listener_sha" "$qml_sha"
