#!/usr/bin/env bash
set -euo pipefail
. "$(dirname -- "${BASH_SOURCE[0]}")/producer-run.sh"

if [[ $# != 4 ]]; then
  printf 'usage: %s LINKED_TOOLCHAIN_ROOT COMPILER VERIFIER SCRATCH_ROOT\n' "$0" >&2
  exit 2
fi

root=$(realpath -e -- "$1")
here=$(cd -- "$(dirname -- "$0")" && pwd)
compiler=$(realpath -e -- "$2")
verifier=$(realpath -e -- "$3")
scratch=$(realpath -e -- "$4")
readelf=$root/usr/bin/readelf
objcopy=$root/usr/bin/objcopy
assembler=$root/usr/bin/as
preprocessor=$root/usr/bin/cpp
keygen=$root/usr/bin/ssh-keygen
xz=$root/usr/bin/xz
assembly=$here/toolchain-preflight.s
preprocessing=$here/toolchain-preflight.c
sample=$root/usr/bin/gcc
for program in "$readelf" "$objcopy" "$assembler" "$preprocessor" "$sample" "$keygen" "$xz"; do
  if [[ ! -x $program ]]; then
    printf 'post-link toolchain preflight: missing linked executable: %s\n' \
      "$program" >&2
    exit 1
  fi
done

# The toolchain itself exercises relocation-bearing ELF parsing and binary
# extraction. This gate checks real execution before the release-wide stage
# spends minutes building the kernel and package population.
key=$(
  {
    sha256sum "$compiler" "$verifier" "$readelf" "$objcopy" "$assembler" "$preprocessor" "$sample" "$keygen" "$xz"
    sha256sum "$0" "$assembly" "$preprocessing"
  } | sha256sum | cut -d' ' -f1
)
checkpoint=$scratch/postlink-toolchain-preflight-$key.complete
if [[ -f $checkpoint ]]; then
  printf 'post-link toolchain preflight: cached green (%s)\n' "$key"
  exit 0
fi

stage=$(mktemp -d -- "$scratch/.postlink-toolchain-preflight.XXXXXXXX")
cleanup() {
  rm -f -- "$stage/readelf" "$stage/objcopy" "$stage/as" "$stage/cpp" "$stage/ssh-keygen" "$stage/xz" \
    "$stage/source-relocs" "$stage/optimized-relocs" \
    "$stage/source-errors" "$stage/optimized-errors" \
    "$stage/source-binary" "$stage/optimized-binary" \
    "$stage/source-object" "$stage/optimized-object" \
    "$stage/source-preprocessed" "$stage/optimized-preprocessed" \
    "$stage/source-key" "$stage/source-key.pub" \
    "$stage/optimized-key" "$stage/optimized-key.pub" \
    "$stage/source-public" "$stage/optimized-public" \
    "$stage/source-derived" "$stage/optimized-derived" \
    "$stage/source.xz" "$stage/optimized.xz" "$stage/decoded"
  rmdir -- "$stage"
}
trap cleanup EXIT
ulimit -c 0

producer_run compiler "$compiler" "$readelf" -o "$stage/readelf"
producer_run verifier "$verifier" "$readelf" "$stage/readelf"

if ! timeout 30 "$readelf" -rW "$sample" \
    >"$stage/source-relocs" 2>"$stage/source-errors"; then
  printf 'post-link toolchain preflight: linked readelf -rW failed\n' >&2
  exit 1
fi
if ! timeout 30 "$stage/readelf" -rW "$sample" \
    >"$stage/optimized-relocs" 2>"$stage/optimized-errors"; then
  sed -n '1,8p' "$stage/optimized-errors" >&2
  printf 'post-link toolchain preflight: optimized readelf -rW failed; refusing release publication\n' >&2
  exit 1
fi
if ! cmp -s -- "$stage/source-relocs" "$stage/optimized-relocs" \
    || ! cmp -s -- "$stage/source-errors" "$stage/optimized-errors"; then
  printf 'post-link toolchain preflight: readelf -rW changed its output\n' >&2
  exit 1
fi

producer_run compiler "$compiler" "$objcopy" -o "$stage/objcopy"
producer_run verifier "$verifier" "$objcopy" "$stage/objcopy"
# GCC retains a local-exec TLS construction marker that both upstream BFD
# versions reject when reopening the linked image. Use the linked readelf
# image for extraction; the relocation parser still exercises GCC above.
if ! timeout 30 "$objcopy" -O binary "$readelf" \
    "$stage/source-binary"; then
  printf 'post-link toolchain preflight: linked objcopy -O binary failed\n' >&2
  exit 1
fi
if ! timeout 30 "$stage/objcopy" -O binary "$readelf" \
    "$stage/optimized-binary"; then
  printf 'post-link toolchain preflight: optimized objcopy -O binary failed; refusing release publication\n' >&2
  exit 1
fi
if ! cmp -s -- "$stage/source-binary" "$stage/optimized-binary"; then
  printf 'post-link toolchain preflight: objcopy -O binary changed its output\n' >&2
  exit 1
fi

producer_run compiler "$compiler" "$assembler" -o "$stage/as"
producer_run verifier "$verifier" "$assembler" "$stage/as"
timeout 30 "$assembler" --64 --fatal-warnings -o "$stage/source-object" "$assembly"
timeout 30 "$stage/as" --64 --fatal-warnings -o "$stage/optimized-object" "$assembly"
if ! cmp -s -- "$stage/source-object" "$stage/optimized-object"; then
  printf 'post-link toolchain preflight: assembler changed its object bytes\n' >&2
  exit 1
fi

producer_run compiler "$compiler" "$preprocessor" -o "$stage/cpp"
producer_run verifier "$verifier" "$preprocessor" "$stage/cpp"
# This isolated driver test moves cpp outside its installed prefix. Give both
# drivers the same pinned cc1 dependency explicitly; installed-root tests
# below still have to prove ordinary prefix discovery without this option.
cc1=$("$sample" -print-prog-name=cc1)
if [[ ! -x $cc1 ]]; then
  printf 'post-link toolchain preflight: declared cc1 is missing: %s\n' "$cc1" >&2
  exit 1
fi
cc1_directory=$(dirname -- "$cc1")
timeout 30 "$preprocessor" -B"$cc1_directory/" -P -nostdinc "$preprocessing" \
  >"$stage/source-preprocessed"
timeout 30 "$stage/cpp" -B"$cc1_directory/" -P -nostdinc "$preprocessing" \
  >"$stage/optimized-preprocessed"
if ! cmp -s -- "$stage/source-preprocessed" "$stage/optimized-preprocessed"; then
  printf 'post-link toolchain preflight: cpp changed preprocessing bytes\n' >&2
  exit 1
fi

# An option switch can pass --version while its first real key operation
# jumps into an instruction interior. Reject that before the full bake.
producer_run compiler "$compiler" "$keygen" -o "$stage/ssh-keygen"
producer_run verifier "$verifier" "$keygen" "$stage/ssh-keygen"
for variant in source optimized; do
  program=$keygen
  if [[ $variant == optimized ]]; then program=$stage/ssh-keygen; fi
  timeout 30 "$program" -q -t ed25519 -N '' -C preflight-only \
    -f "$stage/$variant-key"
  timeout 30 "$program" -y -f "$stage/$variant-key" \
    >"$stage/$variant-public"
  awk '{print $1, $2}' "$stage/$variant-public" >"$stage/$variant-derived"
  awk '{print $1, $2}' "$stage/$variant-key.pub" | \
    cmp -s - "$stage/$variant-derived"
  timeout 30 "$program" -l -f "$stage/$variant-key.pub" | grep -q ED25519
done

# A memory-indexed range-coder switch exercises effective-address substitution
# that --version and decompression alone do not reach. Pair the actual streams
# and recover the original input, with both serial and threaded encoders.
producer_run compiler "$compiler" "$xz" -o "$stage/xz"
producer_run verifier "$verifier" "$xz" "$stage/xz"
for threads in 1 2 0; do
  timeout 30 "$xz" -T"$threads" -c "$preprocessing" >"$stage/source.xz"
  timeout 30 "$stage/xz" -T"$threads" -c "$preprocessing" >"$stage/optimized.xz"
  cmp -- "$stage/source.xz" "$stage/optimized.xz"
  timeout 30 "$stage/xz" -dc "$stage/source.xz" >"$stage/decoded"
  cmp -- "$preprocessing" "$stage/decoded"
done

printf 'post-link toolchain preflight: green (readelf, objcopy, as, cpp, Ed25519, serial/threaded xz)\n'
printf '%s\n' "$key" >"$checkpoint.tmp"
mv -- "$checkpoint.tmp" "$checkpoint"
