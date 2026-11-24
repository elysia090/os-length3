# Ordinary dynamic ELF fixture

This is an AMD64 C PIE with a genuine, separately linked DSO, not an
interpreter stub, Quickshell, Qt or a distribution. Its only expected stdout
is `dynamic-pie:42` followed by a newline. The program needs the DSO's
constructor and calls a library function before printing. It uses the ordinary
Debian interpreter path and a standard `$ORIGIN` runpath. It uses no host
library or interpreter override when staged as the guest fixture.

Supply the exact `libc6_2.41-12+deb13u5_amd64.deb` from the Debian trixie
signed Packages index. The hash in [libc6.sha256](libc6.sha256) is the
release-index pin, not merely a checksum from the unpacked tree. Staging is
offline; it verifies the archive and package identity before extracting
payloads. Nothing is installed. The only build input beyond that archive is
the existing AMD64 C toolchain (set `SODS_FIXTURE_CC` to select it).
The package supplies the matching interpreter and libc together.

```sh
cargo build --manifest-path ricebox/sods/Cargo.toml --locked --release \
  --target wasm32-unknown-unknown --lib --features dynamic-load-plan
sh ricebox/sods/test/fixtures/dynamic/stage.sh LIBC6_DEB NEW_ROOT
SODS_TEST_DYNAMIC_ROOT=NEW_ROOT SODS_CURRENT_TRANSLATOR_WASM=PATH_TO_CURRENT_SODS_WASM \
  node --test ricebox/sods/test/runtime/dynamic-plan.test.ts
```

Run the native reference only in an authorized native runner that already
supports launching an isolated root with these exact paths. Set
`SODS_TEST_DYNAMIC_NATIVE=1` there to test ordinary native exec inside that
root through `chroot`. Lack of permission is a missing prerequisite, not
a reason to change privileges or call the loader directly. A regular
native run against a different host glibc is a control, not the matched
native reference, and does not establish Sods execution.

The guest tests authenticate the fixture identity, describe its ELF load
headers, and build the program and interpreter's detached initial
memory and Linux stack from the actual Vfs. They verify the two
entries, file bytes and BSS, page rights (including the full GNU RELRO
pages named by each object's mapped headers) and stack without
publishing a task or running an interpreter. The mapped-VM tests check
the ordinary mprotect permission reduction on initialized data pages
with an internal process owner. Default Sods exec still refuses the PIE.

With a translator built with `mapped-code`, set `SODS_TEST_MAPPED_WASM`
to the same Wasm path to also prove the one-use transfer to an
unpublished Task and rollback on a stale descriptor table or holding
mount. The commit checks the normal executable metadata, credentials,
and the close-on-exec boundary without publishing the Process. The
resulting Task is held: no guest instructions are compiled or executed.

The explicit dependency catalogue covers the matched libc and the
fixture DSO. The tests check it across the held-image boundary and use
that same plan capability with ordinary in-guest openat/mmap in a
separate checked arena. Planning and handoff make no Vfs payload
requests for these dependencies; each is materialized once when its
exact executable segment is mapped.

### Optional packed-root publication proof

The no-run publication case takes a separately accepted index digest for
the same four members in one ordinary packed root. Build the tiny root
offline from the staged fixture above, recording the archive pin and
local fixture member hashes separately. The app and fixture DSO are not
signed Debian programs; only the interpreter and libc come from the
pinned archive. Do not enroll local files as overlays on a Debian root.

For example, from the repository root with `FIXTURE` pointing at the
staged fixture and `MAPPED_WASM` at an existing mapped-code translator:

```sh
work=$(mktemp -d)
lib=usr/lib/x86_64-linux-gnu
mkdir -p "$work/native/root/etc"
for member in usr/bin/ricebox-pie-fixture "$lib/ld-linux-x86-64.so.2" \
              "$lib/libc.so.6" "$lib/libricebox-pie-fixture.so.1" \
              lib lib64 usr/lib64/ld-linux-x86-64.so.2; do
  mkdir -p "$work/native/root/$(dirname "$member")"
  cp -a "$FIXTURE/$member" "$work/native/root/$member"
done
printf 'NAME="Ricebox local dynamic fixture"\nVERSION_ID="0.0.0"\n' >"$work/native/root/etc/os-release"
printf 'base.profile=local-dynamic-fixture\n' >"$work/native/manifest"
cat ricebox/sods/test/fixtures/dynamic/libc6.sha256 >>"$work/native/manifest"
(cd "$work/native/root" && sha256sum usr/bin/ricebox-pie-fixture "$lib/libricebox-pie-fixture.so.1") >>"$work/native/manifest"
tar -C "$work/native" --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf "$work/root.tar" manifest root
zstd -q -19 -T1 "$work/root.tar" -o "$work/root.tar.zst"
sha=$(sha256sum "$work/root.tar.zst" | cut -d' ' -f1)
archive="$work/ricebox-local-dynamic-0.0.0-x86_64-$sha.tar.zst"
mv "$work/root.tar.zst" "$archive"
node ricebox/distribution/build/distribution.ts "$archive" "$work/web" \
  --translator "$MAPPED_WASM" --hot ',' --cache ''
```

Review both extracted Debian member hashes against the staged fixture
pins, then record the reviewed root's index digest outside the pack.
The test does not take its expected digest from the pack's `webroot.json`.
With that digest and the existing real Muk artifact:

```sh
SODS_TEST_DYNAMIC_PACK_ROOT="$work/web" SODS_TEST_DYNAMIC_PACK_INDEX_SHA256="$ACCEPTED_INDEX_SHA256" \
  RICEBOX_MUK_FILE="$MUK_ARTIFACT" node --test --test-name-pattern='accepted packed fixture' \
  ricebox/sods/test/runtime/dynamic-plan.test.ts
```

This case checks exactly which stored ranges and hashes the normal pack
reader needs, then discards and republishes through the ordinary held
receipt. It never pumps the scheduler, invokes Muk, or executes the linker.
