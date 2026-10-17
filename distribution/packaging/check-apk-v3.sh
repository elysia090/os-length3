#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

if [[ $# != 5 ]]; then
  printf 'usage: %s APK PAYLOAD OUTPUT SIGNING-KEY PUBLIC-KEY\n' "$0" >&2
  exit 2
fi
apk=$(realpath -e -- "$1")
payload=$(realpath -e -- "$2")
output=$3
signing_key=$(realpath -e -- "$4")
public_key=$(realpath -e -- "$5")

# The linked apk is static, so LD_PRELOAD ownership emulation cannot affect
# the metadata it observes.  A root-mapped user namespace makes the current
# build uid/gid canonically 0:0 without copying or modifying the owner root.
if [[ ${QM_PACKAGE_USERNS:-0} != 1 ]]; then
  exec unshare --user --map-root-user \
    env QM_PACKAGE_USERNS=1 bash "$0" \
      "$apk" "$payload" "$output" "$signing_key" "$public_key"
fi
if [[ $(id -u):$(id -g) != 0:0 ]]; then
  printf 'package publication user namespace is not root-mapped\n' >&2
  exit 1
fi
if [[ -e $output ]]; then
  printf 'apk v3 check output already exists: %s\n' "$output" >&2
  exit 1
fi

mkdir -p "$output/repository" "$output/candidate/etc/apk/keys"
package=$output/repository/system-config-0.1.0-r0.apk
index=$output/repository/Packages.adb
key_name=$(basename -- "$public_key")
install -m 0644 "$public_key" "$output/candidate/etc/apk/keys/$key_name"
"$apk" --sign-key "$signing_key" mkpkg --files "$payload" \
  --info name:system-config \
  --info version:0.1.0-r0 \
  --info arch:x86_64 \
  --info description:'immutable configuration smoke package' \
  --info license:LicenseRef-libqm-prototype \
  --info origin:system-config \
  --info url:https://github.com/elysia090/libqm-prototype \
  --output "$package"
"$apk" --root "$output/candidate" --sign-key "$signing_key" mkndx \
  --output "$index" "$package"

"$apk" --root "$output/candidate" verify \
  "$package" "$index"
"$apk" --root "$output/candidate" --no-network \
  --repository "$index" add --initdb \
  system-config=0.1.0-r0

for path in etc/nftables.conf etc/ssh/ssh_config etc/hosts; do
  if [[ ! -f $output/candidate/$path ]] || \
     [[ $(stat -c '%u:%g' -- "$output/candidate/$path") != 0:0 ]]; then
    printf 'apk v3 ownership projection failed: /%s\n' "$path" >&2
    exit 1
  fi
done
if ! grep -q '^P:system-config$' \
     "$output/candidate/lib/apk/db/installed"; then
  printf 'apk v3 installed database lost package identity\n' >&2
  exit 1
fi

printf 'apk v3 mkpkg/sign/index/install ownership: green\n'
