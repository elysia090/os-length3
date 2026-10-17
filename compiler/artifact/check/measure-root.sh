#!/usr/bin/env bash
set -euo pipefail

program=${1:?usage: measure-root.sh PROGRAM}
temporary=$(mktemp -d)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT HUP INT TERM

root=$temporary/root
mkdir -p "$root"
dd if=/dev/zero of="$root/a" bs=4096 count=1 status=none
printf x >>"$root/a"
cp "$root/a" "$root/b"
ln "$root/a" "$root/c"
dd if=/dev/zero of="$root/d" bs=4096 count=1 status=none

report=$temporary/report
"$program" "$root" "$report"
expect() {
  local row=$1
  grep -qxF "$row" "$report" || {
    printf 'missing immutable-page measurement: %s\n' "$row" >&2
    cat "$report" >&2
    exit 1
  }
}

expect format=artifact-immutable-page-population-v4
expect identity=extent-and-exact-bytes
expect digest_role=candidate-index-only
expect regular_paths=4
expect regular_inodes=3
expect inode_file_bytes=12290
expect page_reads=5
expect page_input_bytes=12290
expect zero_pages=3
expect zero_bytes=12288
expect duplicate_nonzero_pages=1
expect duplicate_nonzero_bytes=1
expect unique_nonzero_pages=1
expect page_quotient_payload_upper_bound_bytes=1
expect class.other.input_bytes=12290
expect class.other.page_quotient_payload_bytes=1

elf_root=$temporary/elf-root
mkdir -p "$elf_root"
printf 'int main(void) { return 0; }\n' >"$temporary/main.c"
${CC:-cc} "$temporary/main.c" -o "$elf_root/program"
elf_report=$temporary/elf-report
"$program" "$elf_root" "$elf_report"
elf_bytes=$(stat -c %s -- "$elf_root/program")
accounted=$(sed -n 's/^elf.accounted_bytes=//p' "$elf_report")
executable=$(sed -n 's/^elf.load_executable_bytes=//p' "$elf_report")
if [[ $accounted != "$elf_bytes" || ! $executable =~ ^[1-9][0-9]*$ ]]; then
  printf 'ELF byte population is not exactly partitioned\n' >&2
  cat "$elf_report" >&2
  exit 1
fi

archive_root=$temporary/archive-root
mkdir -p "$archive_root"
printf 'int archive_a(void) { return 1; }\n' >"$temporary/a.c"
printf 'int archive_b(void) { return 2; }\n' >"$temporary/b.c"
${CC:-cc} -c "$temporary/a.c" -o "$temporary/a.o"
${CC:-cc} -c "$temporary/b.c" -o "$temporary/b.o"
${AR:-ar} rcsD "$archive_root/library.a" \
  "$temporary/a.o" "$temporary/b.o"
cp "$archive_root/library.a" "$archive_root/library-copy.a"
archive_report=$temporary/archive-report
"$program" "$archive_root" "$archive_report"
archive_bytes=$(($(stat -c %s -- "$archive_root/library.a") * 2))
member_payload_bytes=$(($(stat -c %s -- "$temporary/a.o") \
  + $(stat -c %s -- "$temporary/b.o")))
grep -qxF 'archive.identity=canonical-gnu-ar-view-v1' "$archive_report"
grep -qxF 'archive.member_occurrences=4' "$archive_report"
grep -qxF 'archive.unique_member_payloads=2' "$archive_report"
grep -qxF "archive.member_payload_bytes=$((member_payload_bytes * 2))" \
  "$archive_report"
grep -qxF "archive.unique_member_payload_bytes=$member_payload_bytes" \
  "$archive_report"
grep -qxF "archive.duplicate_member_payload_bytes=$member_payload_bytes" \
  "$archive_report"
grep -qxF "archive.input_stream_bytes=$archive_bytes" "$archive_report"
grep -qxF "archive.generated_stream_bytes=$archive_bytes" "$archive_report"
grep -qxF 'archive.rewritten_streams=0' "$archive_report"

printf 'artifact immutable-page/ELF/archive population: green\n'
