#!/usr/bin/env bash
set -euo pipefail
umask 077
# Ordinary intended opt-in only. Do not use this on main or the C++ run/ref.
p=$(cd -- "$(dirname -- "$0")" && pwd)
int=$(cd -- "$p/../.." && pwd)
phase=opt-in
trace_reported=0
finish() {
   local rc=$?
   if ((rc)); then
      if [[ "$phase" == stock-chrome-sandbox && ${trace:-} ]] && ((!trace_reported)); then
         node "$p/preflight-diagnostics.mjs" report "$trace" partial 2>/dev/null || :
      fi
      printf 'RX_EVERYDAY_DERIVATIVE_HOLD stage=%s code=%d\n' "$phase" "$rc"
   fi
}
trap finish EXIT
[[ ${GITHUB_REPOSITORY:-} == elysia090/os-length3 &&
   ${GITHUB_EVENT_NAME:-} == workflow_dispatch && ${GITHUB_ACTOR_ID:-} == 148540043 &&
   ${GITHUB_ACTOR:-} == elysia090 && ${GITHUB_TRIGGERING_ACTOR:-} == elysia090 &&
   ${GITHUB_REF:-} == refs/heads/diag/everyday-static-28c45a6 ]]
[[ "$#" = 2 ]]; mode=$1; product=$(cd -- "$2" && pwd)
w="${RUNNER_TEMP:?}/rx-everyday-shell-28c45a6"
stock="$product/ricebox/everyday/test/wayland/browser/stock-chrome.ts"
qa="$int/ricebox/everyday/test/wayland/static-acceptance"
head=28c45a65649b1058da0ad5077624e8fd4fa3cee9
base=9617595bbdf413ca596ebc9a34433d97288ee37f
release_sha=ec84d6a4f34359f322726e323e294b03987a19b1aa544563c846ca1a83060ee3
root_sha=7420a34199c6708bc619cac3bce88af75559cf8ed6d8c495074e89e05b6fe509
muk_sha=0668fceb53911c4a9f89f013ce94c92eeac9df62754dfba4bc563fe7384c6348
original="os-length3-linux-0.6.5-x86_64-$release_sha.tar.zst"
api=https://api.github.com/repos/elysia090/os-length3
assets=https://github.com/elysia090/os-length3/releases/download/os-length3-linux-v0.6.5
archive="$w/native/ricebox-0.0.1-x86_64-$root_sha.tar.zst"
stock_path="$w/sandbox"
trace="$w/sandbox.trace"
export LC_ALL=C LANG=C TZ=UTC SOURCE_DATE_EPOCH=0
[[ $(git -C "$product" rev-parse HEAD 2>/dev/null) == "$head" && -z $(git -C "$product" status --porcelain --untracked-files=no 2>/dev/null) ]]
[[ $(git -C "$int" rev-parse HEAD^ 2>/dev/null) == "$base" && $(git hash-object "$stock" 2>/dev/null) == 6db7dd3f7583c3aa695a37ce0cb86d7068b80dbf ]]
pin() { printf '%s  %s\n' "$1" "$2" | sha256sum -c -; }
stage() { phase=$1; shift; printf 'RX_EVERYDAY_DERIVATIVE_STAGE %s\n' "$phase"; "$@" >"$w/$phase.log" 2>&1; }
tools() {
   [[ $(node --version) == v24.22.3 && $(uname -m) == x86_64 ]]
   tar --version > "$w/tar-version"
   zstd --version > "$w/zstd-version"
   grep -Eq '^tar \(GNU tar\) 1[.]35$' "$w/tar-version"
   grep -Eq 'v1[.]5[.]7([^0-9]|$)' "$w/zstd-version"
   command -v curl; command -v docker; command -v npm; command -v python3
}
chrome() {
   local doctor_rc=0
   local diag="$p/preflight-diagnostics.mjs"
   node "$diag" init "$trace"
   node "$diag" mark "$trace" doctor-invoke start
   node "$qa/run-static-acceptance.mjs" --doctor >"$w/doctor.json" 2>"$w/doctor.stderr" || doctor_rc=$?
   if ((doctor_rc)); then
      node "$diag" doctor "$trace" "$w/doctor.json" "$doctor_rc" || :
      return "$doctor_rc"
   fi
   node "$diag" doctor "$trace" "$w/doctor.json" "$doctor_rc"
   node "$diag" mark "$trace" sandbox-fixture start
   if ! (mkdir "$stock_path" &&
      cp "$stock" "$stock_path/stock-chrome.ts" &&
      cp "$qa/sealed-parent/ricebox-transfer-receipt-f0748b1/capture.mjs" "$stock_path/" &&
      cp "$qa/sandbox-same-process.mjs" "$p/sandbox-preflight.mjs" "$diag" "$stock_path/" &&
      cd "$stock_path" &&
      pin 78eaee010b2ff951c163984f258b8574ca255a9710a327db1b13f2f5c5c9c42f capture.mjs &&
      pin 09ec7ff4a68a577ebe695669fff557710e04da68754af755dedba1b3fbe2af23 sandbox-same-process.mjs &&
      pin ca21ab0f38293bf4331576e341132f8a129d5650e85f6702ebed9b29494d4b4b "$p/sandbox-observers.patch" &&
      git apply --whitespace=error --check "$p/sandbox-observers.patch" &&
      git apply --whitespace=error "$p/sandbox-observers.patch" &&
      pin d230c0bc69e7cba13ac5101f4865afb71d6c7fbbf3cf68a9307afdfb60a3a14f capture.mjs &&
      pin 3e09238fac5e189fbbf0e9d0499b65802ec8612055f8e2b102ee03435f8bd8be sandbox-same-process.mjs); then
      node "$diag" mark "$trace" sandbox-fixture hold
      return 1
   fi
   node "$diag" mark "$trace" sandbox-fixture pass
   node "$stock_path/sandbox-preflight.mjs" "$trace"
}
muk() {
   # Raw Muk includes Debian GCC's .comment; a stock Ubuntu GCC can have the
   # same reported number but still cannot establish this exact pin.
   local image=debian@sha256:7378260c0a098d27ac206225db5e7d92b8c7c84ea7afccc86eeb513756bbd392
   mkdir -p "$w/toolchain/muk"
   docker pull --platform linux/amd64 "$image"
   [[ $(docker image inspect --format '{{.Os}} {{.Architecture}} {{.Id}}' "$image") == \
        'linux amd64 sha256:596c6d80c879dc94eae22cb9c59a5e18f66f4f9722e170892324c282b4eb19bc' ]]
   docker run --rm --platform linux/amd64 -v "$product:/source:ro" -v "$w/toolchain/muk:/out" \
      -e "OWNER=$(id -u):$(id -g)" "$image" sh -ec '
        umask 022
        export LC_ALL=C LANG=C TZ=UTC SOURCE_DATE_EPOCH=0 DEBIAN_FRONTEND=noninteractive
        apt-get update -qq
        apt-get install -y -qq --no-install-recommends gcc-14=14.2.0-19 binutils=2.44-3
        test "$(dpkg-query -W -f="\${Version}" gcc-14)" = 14.2.0-19
        test "$(dpkg-query -W -f="\${Version}" binutils)" = 2.44-3
        CC=gcc-14 sh /source/ricebox/toolchain/build.sh /source/ricebox/muk/src/muk.c /out/muk
        chown "$OWNER" /out/muk
   '
   pin "$muk_sha" "$w/toolchain/muk/muk"
}
if [[ "$mode" == preflight ]]; then
   phase=runner-private-temp
   [[ ! -e "$w" && ! -L "$w" ]]
   mkdir -m 0700 -- "$w"
   stage tools tools
   stage stock-chrome-sandbox chrome
   trace_reported=1
   node "$p/preflight-diagnostics.mjs" report "$trace" complete 2>/dev/null
   stage exact-muk muk
   printf '%s\n' "$head" > "$w/preflight.ok"
   exit 0
fi
phase=preflight-receipt
[[ -d "$w" && ! -L "$w" && $(cat "$w/preflight.ok" 2>/dev/null) == "$head" ]]
if [[ "$mode" == fetch ]]; then
   phase=authenticated-metadata
   [[ -n ${RX_ARTIFACT_READ_TOKEN:-} ]]
   # No -v, tracing, retained credentials or cross-host forwarding. Normal curl
   # redirect policy drops the Authorization header on the public CDN redirect.
   ccurl=(curl -fsS --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 90 --retry 1)
   stage release-metadata "${ccurl[@]}" "$api/releases/tags/os-length3-linux-v0.6.5" -o "$w/release.json"
   stage actions-metadata "${ccurl[@]}" -H "Authorization: Bearer $RX_ARTIFACT_READ_TOKEN" \
      -H 'Accept: application/vnd.github+json' "$api/actions/artifacts/14668298333" -o "$w/artifact.json"
   stage metadata-pin python3 -B "$p/collect-pins.py" metadata "$w/release.json" "$w/artifact.json"
   stage translator-download "${ccurl[@]}" --location -H "Authorization: Bearer $RX_ARTIFACT_READ_TOKEN" \
      -H 'Accept: application/vnd.github+json' --max-filesize 8232897 "$api/actions/artifacts/14668298333/zip" -o "$w/translator.zip"
   unset RX_ARTIFACT_READ_TOKEN
   stage translator-pin python3 -B "$p/collect-pins.py" extract "$w/translator.zip" "$w/sods.wasm"
   stage carrier-download "${ccurl[@]}" --location --max-filesize 115302848 "$assets/$original" -o "$w/$original"
   stage carrier-pin pin "$release_sha" "$w/$original"
   printf '%s\n' "$head" > "$w/fetch.ok"
   exit 0
fi
phase=fetch-receipt
[[ "$mode" == run && -z ${RX_ARTIFACT_READ_TOKEN:-} && $(cat "$w/fetch.ok" 2>/dev/null) == "$head" ]]
cd -- "$product"
historic() { (umask 022; python3 -B "$p/derive-from-pinned-release.py" "$w/$original" "$w/packages"); }
stage historical-busybox historic
stage exact-current-config sh "$p/build-current-config.sh" "$product" "$w/packages" "$w"
build_archive() { (umask 022; sh ricebox/distribution/build/assemble.sh "$w/packages" "$w/native"); pin "$root_sha" "$archive"; }
stage derivative-assemble build_archive
stage exact-stock-packer env RX_ATTESTED_WASM="$w/sods.wasm" node ricebox/distribution/build/distribution.ts \
   "$archive" "$w/prepared" --translator "$w/sods.wasm" --sods "$p/wasm-aot-adapter.mjs" --hot /usr/bin/busybox --cache "$w/aot"
# muk-artifact checks mtime against product source. Any rewrite or drift is caught
# by the current-source Muk pin and all five independent prepared-root pins.
stage exact-current-muk env CARGO_TARGET_DIR="$w/toolchain" node ricebox/distribution/build/muk-artifact.ts "$w/prepared"
stage derivative-identity node "$p/verify-private-prepared.mjs" "$product" "$archive" "$w/prepared" "$w/sods.wasm" "$w/observed-pins.json"
write_approval() {
   python3 -B "$p/collect-pins.py" approval "$p/expected-component-pins.json" "$w/observed-pins.json" > "$w/approved-root.json"
}
stage fixed-prior-approval write_approval
attribution="$w/worker-attribution"
stage_attribution() (
   mkdir "$attribution"
   cp "$qa/run-static-acceptance.mjs" "$qa/sandbox-same-process.mjs" "$qa/probe-staged.mjs" "$p/worker-attribution.mjs" "$attribution/"
   cd "$attribution"
   pin 10fcf6d070c128f9aa51bf50995ee28bb2117684d2df5c5a14ed473e76b00ca4 run-static-acceptance.mjs
   pin 09ec7ff4a68a577ebe695669fff557710e04da68754af755dedba1b3fbe2af23 sandbox-same-process.mjs
   pin 8c1908ee76a694d52ec2ad030e9f817de61dd644a770cb58b792cec96be1c79c probe-staged.mjs
   pin fa1b385f5d4629c08947c5258da763a3b23a5e234c1934c55bc721bac8af30f7 worker-attribution.mjs
   pin b22f57b1a2593b94e10981d5e8712fe0d6fade388893606c48fe46cfe75a6271 "$p/worker-attribution-observer.patch"
   git apply --whitespace=error --check "$p/worker-attribution-observer.patch"
   git apply --whitespace=error "$p/worker-attribution-observer.patch"
   pin 74350247ee147de3de0d2ffdf903a79e837b4f5247476e28f9272e09aaac4521 run-static-acceptance.mjs
)
stage worker-attribution-observers stage_attribution
phase=stock-chrome-shell
rc=0
node "$attribution/run-static-acceptance.mjs" "$product" "$w/prepared" "$w/approved-root.json" \
  "$qa/sealed-parent" "$w/browser-report" > "$w/shell-summary.stdout" 2>"$w/shell-summary.stderr" || rc=$?
node "$p/worker-attribution.mjs" "$w/browser-report" "$p/expected-component-pins.json" 2>/dev/null || :
node "$p/allowlist-summary.mjs" "$w/shell-summary.stdout"
exit "$rc"
