#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 2 || ! -d $1 || ! -d $2 ]]; then
  printf 'usage: %s LINKED_PACKAGE_FOREST OPTIMIZED_PACKAGE_ROOT\n' "$0" >&2
  exit 2
fi

linked=$(realpath -e -- "$1")
optimized=$(realpath -e -- "$2")
parent=$(dirname -- "$optimized")
scratch=$(mktemp -d -- "$parent/.native-parity.XXXXXXXX")
cleanup() {
  if [[ $scratch == "$parent"/.native-parity.* && -d $scratch ]]; then
    rm -rf -- "$scratch"
  fi
}
trap cleanup EXIT HUP INT TERM

compare_command() {
  local name=$1 relative=$2
  shift 2
  local original="$linked/$relative"
  local compiled="$optimized/$relative"
  if [[ ! -x $original || ! -x $compiled ]]; then
    printf 'native parity: missing executable: %s\n' "$relative" >&2
    return 1
  fi
  if ! timeout 60s "$original" "$@" \
       >"$scratch/$name.linked.out" 2>"$scratch/$name.linked.err"; then
    printf 'native parity: linked %s failed\n' "$name" >&2
    return 1
  fi
  if ! timeout 60s "$compiled" "$@" \
       >"$scratch/$name.optimized.out" 2>"$scratch/$name.optimized.err"; then
    printf 'native parity: optimized %s failed\n' "$name" >&2
    return 1
  fi
  if ! cmp -s -- "$scratch/$name.linked.out" "$scratch/$name.optimized.out" \
      || ! cmp -s -- "$scratch/$name.linked.err" "$scratch/$name.optimized.err"; then
    printf 'native parity: %s output differs\n' "$name" >&2
    return 1
  fi
}

compare_command busybox busybox/bin/busybox --list
compare_command busybox-shell busybox/bin/busybox sh -c \
  'f() { echo shell-function-ok; }; f'
compare_command gcc gcc/usr/bin/gcc --version
compare_command ld binutils/usr/bin/ld --version
compare_command curl curl/usr/bin/curl --version
smoke_source=$(realpath -e -- "$(dirname -- "${BASH_SOURCE[0]}")/../toolchain/smoke.c")
compare_command gzip gzip/usr/bin/gzip -n -c "$smoke_source"

# Option lookup must not depend on the process address layout. A missing key
# produces a stable error after --sign-key is recognized; repeat the parse so
# an address-sensitive native miscompile cannot pass the publication gate.
for applet in mkpkg mkndx; do
  original="$linked/apk-tools/usr/bin/apk"
  compiled="$optimized/apk-tools/usr/bin/apk"
  if [[ ! -x $original || ! -x $compiled ]]; then
    printf 'native parity: missing apk executable\n' >&2
    exit 1
  fi
  if expected=$(timeout 5s "$original" "$applet" \
      --sign-key "$scratch/missing-signing-key" 2>&1); then
    printf 'native parity: linked apk accepted a missing signing key\n' >&2
    exit 1
  fi
  for attempt in {1..32}; do
    if actual=$(timeout 5s "$compiled" "$applet" \
        --sign-key "$scratch/missing-signing-key" 2>&1); then
      printf 'native parity: optimized apk accepted a missing signing key\n' >&2
      exit 1
    fi
    if [[ $actual != "$expected" ]]; then
      printf 'native parity: apk %s option parse differs on attempt %s\n' \
        "$applet" "$attempt" >&2
      exit 1
    fi
  done
done

# Successful startup does not establish linker semantics.  Assemble one
# source object once and require both linked and optimized ld to produce the
# same relocatable ELF, including its symbol and relocation tables.
fixture=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)/compiler/postlink-compiler/check/elf-proof-fixture.c
if ! timeout 60s "$linked/gcc/usr/bin/gcc" -S -O2 -nostdinc \
     "$fixture" -o "$scratch/linked-gcc.s"; then
  printf 'native parity: linked GCC compile failed\n' >&2
  exit 1
fi
if ! timeout 60s "$optimized/gcc/usr/bin/gcc" -S -O2 -nostdinc \
     "$fixture" -o "$scratch/optimized-gcc.s"; then
  printf 'native parity: optimized GCC compile failed\n' >&2
  exit 1
fi
if ! cmp -s -- "$scratch/linked-gcc.s" "$scratch/optimized-gcc.s"; then
  printf 'native parity: GCC assembly output differs\n' >&2
  exit 1
fi

# A small translation unit does not exercise GCC's interprocedural analysis.
# Compare the physical-SSA test and every compiler translation unit. One real
# failure appeared only in block.c: a computed jump lost the flags consumed
# by its target. Startup, a tiny C function and physical.c had all passed.
# These are build-side witnesses, not additional distribution payloads.
physical=$(dirname -- "$fixture")/physical.c
source_root=$(cd -- "$(dirname -- "$fixture")/../.." && pwd)
includes=(
  "-I$source_root/postlink-compiler/include"
  "-I$source_root/postlink-compiler/src"
  "-I$source_root/support/include"
  "-I$source_root/x86/include"
  "-I$source_root/optimized-x86/include"
)
mapfile -d '' translation_units < <(
  printf '%s\0' "$physical"
  find "$source_root/postlink-compiler/src" -type f -name '*.c' -print0 | sort -z
)
for translation_unit in "${translation_units[@]}"; do
  if ! timeout 30s "$linked/gcc/usr/bin/gcc" -S -O2 -std=c11 \
       "${includes[@]}" "$translation_unit" -o "$scratch/linked-unit.s"; then
    printf 'native parity: linked GCC compile failed: %s\n' \
      "$translation_unit" >&2
    exit 1
  fi
  if ! timeout 30s "$optimized/gcc/usr/bin/gcc" -S -O2 -std=c11 \
       "${includes[@]}" "$translation_unit" -o "$scratch/optimized-unit.s"; then
    printf 'native parity: optimized GCC compile failed: %s\n' \
      "$translation_unit" >&2
    exit 1
  fi
  if ! cmp -s -- "$scratch/linked-unit.s" "$scratch/optimized-unit.s"; then
    printf 'native parity: GCC assembly output differs: %s\n' \
      "$translation_unit" >&2
    exit 1
  fi
done

cc -c -o "$scratch/fixture.o" "$fixture"
# A format decoder's computed dispatch must retain every case target.  This
# checks the actual database and input object, not just `file --version`.
magic="$optimized/file/usr/share/misc/magic.mgc"
if [[ ! -s $magic ]]; then
  printf 'native parity: missing file magic database\n' >&2
  exit 1
fi
if ! MAGIC="$magic" timeout 60s "$linked/file/usr/bin/file" \
     "$scratch/fixture.o" >"$scratch/file.linked.out" \
     2>"$scratch/file.linked.err"; then
  printf 'native parity: linked file failed\n' >&2
  exit 1
fi
if ! MAGIC="$magic" timeout 60s "$optimized/file/usr/bin/file" \
     "$scratch/fixture.o" >"$scratch/file.optimized.out" \
     2>"$scratch/file.optimized.err"; then
  printf 'native parity: optimized file failed\n' >&2
  exit 1
fi
if ! cmp -s -- "$scratch/file.linked.out" "$scratch/file.optimized.out" \
    || ! cmp -s -- "$scratch/file.linked.err" \
       "$scratch/file.optimized.err"; then
  printf 'native parity: file classification differs\n' >&2
  exit 1
fi
if ! timeout 60s "$linked/binutils/usr/bin/ld" -r \
     "$scratch/fixture.o" -o "$scratch/linked.o"; then
  printf 'native parity: linked ld -r failed\n' >&2
  exit 1
fi
if ! timeout 60s "$optimized/binutils/usr/bin/ld" -r \
     "$scratch/fixture.o" -o "$scratch/optimized.o"; then
  printf 'native parity: optimized ld -r failed\n' >&2
  exit 1
fi
if ! cmp -s -- "$scratch/linked.o" "$scratch/optimized.o"; then
  printf 'native parity: ld -r output differs\n' >&2
  exit 1
fi

printf 'native parity: green (BusyBox, GCC compile, compiler C population, ld, curl, gzip, apk options, file, ld -r)\n'
