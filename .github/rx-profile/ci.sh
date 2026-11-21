#!/usr/bin/env bash
# Exact test branch only. Keep raw inputs, compiler outputs and raw event streams on the ephemeral runner.
set -euo pipefail
umask 077
self=$(cd -- "$(dirname -- "$0")" && pwd)
product=$(cd -- "$1" && pwd)
work=$(mktemp -d -- "$2/rx-profile.XXXXXX")
hostnode=$(command -v node)
commit=28c45a65649b1058da0ad5077624e8fd4fa3cee9
NINJA=3441b633c2fe2c494e958780ba0f4227b1327634
NINJA_TREE=70dd1324a3997a3ce38bfe70a8291b2ef4a0bf65
ALPINE=alpine@sha256:c26612752c78b18faacd63c7d50f4592c2e7b0f25e0e20e82bd74e465c57ab0d
result="$work/result"
mkdir "$result" "$work/inputs" "$work/native-root" "$work/asmb"
cd "$product"
export SOURCE_DATE_EPOCH=0
if [[ ${GITHUB_EVENT_NAME:-} != workflow_dispatch || ${GITHUB_REF:-} != refs/heads/diag/cc1plus-28c45a6 || ${GITHUB_ACTOR:-} != elysia090 || ${GITHUB_TRIGGERING_ACTOR:-} != elysia090 || ${GITHUB_REPOSITORY:-} != elysia090/os-length3 ]]; then
 echo 'RX_HOLD not the exact authorized manual diagnostic scope'; exit 2
fi
if [[ $(git rev-parse HEAD) != "$commit" || $(uname -m) != x86_64 || $(node --version) != v24.22.3 || -n $(git status --porcelain) ]]; then
 echo 'RX_HOLD unexpected source/host/engine'; exit 2
fi
# The only retained log prints are fixed enums and bounded allowlisted numbers, not diagnostic paths or stderr.
phase=preflight
trap 'rc=$?; if ((rc)); then printf "RX_HOLD stage=%s code=%d\n" "$phase" "$rc"; fi' EXIT
stage() { phase=$1; shift; printf 'RX_STAGE %s\n' "$phase"; "$@" >"$work/$phase.log" 2>&1; }
install_tools() {
 sudo -n apt-get update -qq
 sudo -n apt-get install -y --no-install-recommends bubblewrap zstd binutils
 rustup target add wasm32-unknown-unknown
 docker info --format '{{.ServerVersion}}'
}
stage setup install_tools
verify_builder_image() {
 docker pull --platform linux/amd64 "$ALPINE"
 test "$(docker image inspect --format '{{.Os}} {{.Architecture}} {{.Id}}' "$ALPINE")" = 'linux amd64 sha256:b92841763c5c2140a20eeb2a44e94ebb0e80fd51d9d6b5895ea72fa999525d68'
}
stage builder-image verify_builder_image
stage packages docker run --rm --platform linux/amd64 -v "$product:/w:ro" -v "$work:/rx" -e "OWNER=$(id -u):$(id -g)" "$ALPINE"  sh /w/ricebox/distribution/build/packages.sh /rx/packages gcc binutils busybox linux-headers musl fortify-headers system-config
root_package_provenance() {
 local dir="$work/packages"
 test "$(cat "$dir/gcc/version")" = '16.2.0'
 test "$(cat "$dir/gcc/source")" = 'e6738e29597f733270731aa90600f37ffdc045079dfc27ec7e8192cc81085c3e'
 test "$(cat "$dir/binutils/version")" = '2.47'
 local n
 for n in gcc binutils busybox linux-headers musl fortify-headers system-config; do
  test -d "$dir/$n/tree"
  grep -qxE '[0-9a-f]{64}' "$dir/$n/key"
  test "$(grep -c "^$n " "$dir/record")" = 1
 done
}
stage package-provenance root_package_provenance
assemble() {
 (umask 022; sh ricebox/distribution/build/assemble.sh "$work/packages" "$work/asmb" 0.0.0 ricebox)
 cd "$work/asmb"; sha256sum -c SHA256SUMS
 awk 'NR==1{print $2}' SHA256SUMS >"$work/archive-name"
 sudo -n tar --zstd --numeric-owner -xf "$(cat "$work/archive-name")" -C "$work/native-root"
}
stage assemble assemble
cd "$product"
root="$work/native-root/root"
archive="$work/asmb/$(cat "$work/archive-name")"
compiler() {
 CARGO_TARGET_DIR="$work/trans" cargo build --locked --release --target wasm32-unknown-unknown --lib --manifest-path ricebox/sods/Cargo.toml
}
stage translator compiler
# The nonempty comma string means an explicitly empty hot list. No prebuilt work or result cache is fed into the run.
stage layers "$hostnode" ricebox/distribution/build/distribution.ts "$archive" "$work/layers" --translator "$work/trans/wasm32-unknown-unknown/release/sods.wasm" --hot , --cache "$work/aot"
ccPath=$(find "$root/usr/libexec" -type f -name cc1plus -printf '%P\n')
if [[ $ccPath != x86_64-alpine-linux-musl/16.2.0/cc1plus && $ccPath != gcc/x86_64-alpine-linux-musl/16.2.0/cc1plus ]]; then phase=compiler-identity; exit 1; fi
ccPath=/usr/libexec/"$ccPath"
verify_identity() {
 # Redirected by the unprivileged runner before sudo, rather than leaving a root-owned unreadable 0600 receipt.
 sudo -n "$hostnode" "$self/run-sods.ts" verify "$product" "$work/layers" "$root" "$work/inputs" "$ccPath" "$result" >"$result/identity.json"
}
stage identity verify_identity
bootstrap() {
 git init -q "$work/ninja-src"
 git -C "$work/ninja-src" fetch --depth=1 --no-tags https://github.com/ninja-build/ninja.git "$NINJA"
 git -C "$work/ninja-src" checkout --detach FETCH_HEAD
 test "$(git -C "$work/ninja-src" rev-parse HEAD)" = "$NINJA"
 test "$(git -C "$work/ninja-src" rev-parse 'HEAD^{tree}')" = "$NINJA_TREE"
 docker run --rm --platform linux/amd64 -v "$work/ninja-src:/src" -w /src "$ALPINE" /bin/sh -ec '
  umask 022
  apk add --no-cache build-base python3
  SOURCE_DATE_EPOCH=0 CXXFLAGS="-O2 -fPIE -fstack-protector-strong" LDFLAGS="-static-pie -Wl,-z,relro,-z,now,-z,noexecstack" python3 configure.py --bootstrap
  test "$(./ninja --version)" = 1.13.2
  apk info -v build-base gcc g++ musl-dev python3
 '
 install -m 0755 "$work/ninja-src/ninja" "$work/inputs/ninja"
}
stage ninja-bootstrap bootstrap
# Same validated programs/inputs are read-only on native and copied byte-for-byte into the Sods guest inputs.
guest_env=(--clearenv --setenv HOME /root --setenv PATH /bin:/usr/bin --setenv LANG C --setenv LC_ALL C --setenv TZ UTC --setenv TERM dumb --setenv TMPDIR /tmp --setenv SOURCE_DATE_EPOCH 0)
box() { timeout 180 sudo -n bwrap --unshare-all --unshare-user --uid 0 --gid 0 --die-with-parent --new-session --cap-drop ALL "${guest_env[@]}" --ro-bind "$root" / --proc /proc --dev /dev "$@"; }
staging_timer() {
 cp -a "$self/fixture/." "$work/inputs/"
 chmod 0755 "$work/inputs" "$work/inputs/fixture.sh"
 chmod 0644 "$work/inputs/"*.cc "$work/inputs/"*.h "$work/inputs/build.ninja" "$work/inputs/rx-time.c"
 sudo -n install -d -m 1777 -o 0 -g 0 -- "$work/timer-stage"
 sudo -n install -m 0644 -o 0 -g 0 -- "$work/inputs/rx-time.c" "$work/timer-stage/rx-time.c"
 box --bind "$work/timer-stage" /tmp --chdir /tmp /bin/sh -ec 'umask 022; exec /usr/bin/cc -O2 rx-time.c -o rx-time'
 test -r "$work/timer-stage/rx-time"
 install -m 0755 "$work/timer-stage/rx-time" "$work/inputs/rx-time"
 readelf -Whld "$work/inputs/ninja" >"$result/ninja.elf"
 readelf -Whld "$work/inputs/rx-time" >"$result/timer.elf"
 readelf -Whld "$root$ccPath" >"$result/cc1plus.elf"
 for f in "$result/"*.elf; do
  grep -Eq 'Type: *DYN' "$f"; if grep -Eq '^ *INTERP |\(NEEDED\)|GNU_STACK.*RWE' "$f"; then return 1; fi; grep -q GNU_RELRO "$f"; grep -q GNU_STACK "$f"; grep -Eq 'BIND_NOW|FLAGS_1.*NOW' "$f"
 done
 sha256sum "$work/inputs/"* "$root$ccPath" >"$result/materials"
}
stage timer-and-native-isolation staging_timer
# Serial ABBA pair order, full independent trials. Prime A and verify it first inside each selected engine,
# then edit B and time at the same waitpid cut. No profiler or observer in these rows.
native() {
 local out=$1
 mkdir "$out"  # private runner-owned 0700 parent, never mounted into the guest
 sudo -n install -d -m 1777 -o 0 -g 0 -- "$out/work" # normal /tmp, capless UID 0 can traverse and create compiler temps
 sudo -n install -d -m 0755 -o 0 -g 0 -- "$out/work/rx-in" "$out/work/rx-out"
 box --bind "$out/work" /tmp --ro-bind "$work/inputs" /tmp/rx-in --chdir /tmp/rx-out /bin/sh /tmp/rx-in/fixture.sh >"$out/stdout" 2>"$out/stderr"
 cp "$out/work/rx-out/proof" "$out/proof.bin"
 readelf -Whld "$out/proof.bin" >"$out/proof.elf"
 cat /proc/sys/kernel/random/boot_id >"$out/runner-vm"
 python3 -B - "$out" <<'PY2'
import json,pathlib,stat,sys
o=pathlib.Path(sys.argv[1])
r={}
for n in ('edit_distance.o','driver.o','proof'):
 s=(o/'work/rx-out'/n).stat();r[n]=dict(size=s.st_size,mode=stat.S_IMODE(s.st_mode),uid=s.st_uid,gid=s.st_gid)
(o/'artifacts.json').write_text(json.dumps(r))
PY2
}
sods() {
 local out=$1; mkdir "$out"
 timeout 300 "$hostnode" "$self/run-sods.ts" stock "$product" "$work/layers" "$root" "$work/inputs" "$ccPath" "$out"
 cat /proc/sys/kernel/random/boot_id >"$out/runner-vm"
}
stage native-first native "$result/native-first"
stage sods-first sods "$result/sods-first"
stage sods-second sods "$result/sods-second"
stage native-second native "$result/native-second"
record_capture() {
 python3 -B - "$result" "$archive" "$commit" <<'PY2'
import hashlib,json,pathlib,sys
r,archive=map(pathlib.Path,sys.argv[1:3]);h=hashlib.file_digest(archive.open('rb'),'sha256').hexdigest()
ident=json.loads((r/'identity.json').read_text())
assert ident['root']==h
vm=pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
trials=[dict(name=n,mode='warm-a-to-b',engine=n.split('-')[0],vmId=(r/n/'runner-vm').read_text().strip()) for n in ('native-first','sods-first','sods-second','native-second')]
assert all(t['vmId']==vm for t in trials)
(r/'capture.json').write_text(json.dumps(dict(revision=sys.argv[3],archiveSha=h,rootIndex=ident['index'],translator=ident['translator'],calibration='inline-v1',runnerBootId=vm,trials=trials)))
PY2
}
stage capture record_capture
stage stock-verify python3 -B "$self/aggregate.py" --stock "$result"
collect_sods() {
 local diag="$work/diag" out="$result/sods-profile"
 mkdir -p "$diag/ricebox" "$out" || return $?
 cp -a "$product/ricebox/sods" "$product/ricebox/distribution" "$diag/ricebox/" || return $?
 cp "$product/package.json" "$diag/" || return $? # source type, not an install
 python3 -B "$self/prepare-diag.py" "$diag" || return $?
 timeout 420 "$hostnode" --trace-event-categories 'v8.wasm,v8,node.console' --trace-event-file-pattern "$out/trace.json" "$self/run-sods.ts" profile "$diag" "$work/layers" "$root" "$work/inputs" "$ccPath" "$out" || return $?
 python3 -B "$self/reduce-profile.py" "$out" "$root$ccPath" "$hostnode"
}
# Even if instrumentation fails, retain a bounded stock report and mark diagnostics unavailable.
phase=sods-profile
printf 'RX_STAGE %s\n' "$phase"
if ! collect_sods >"$work/$phase.log" 2>&1; then printf 'RX_LANE sods-profile blocked\n'; fi
phase=aggregate
python3 -B "$self/aggregate.py" "$result"
phase=coverage
cpp=0; python3 -B "$self/coverage.py" "$result/coverage.json" || cpp=$?
python3 -B - "$result" "$cpp" <<'PY2'
import json,pathlib,sys
r=pathlib.Path(sys.argv[1]);x=json.loads((r/'coverage.json').read_text());lanes=x['lanes']
p={k: v['status'] for k,v in lanes.items()}
qualifying=p.get('stock_warm_abba')=='pass'
deep='pass' if sys.argv[2]=='0' else 'partial' if qualifying else 'not_run'
(r/'ricebox-coverage.json').write_text(json.dumps({'groups':{'toolchain':{'cpp_matrix':'partial' if qualifying else 'not_run','cpp_deep':deep}}}))
PY2
all=0; python3 -B "$self/ricebox_coverage.py" "$result/ricebox-coverage.json" || all=$?
((cpp==0 && all==0)) || exit 2
