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
