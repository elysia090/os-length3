# fd: files found by their names, skipping what .gitignore and hidden files say to; what find is reached for.
pins="FD"
tools="rust cargo"
# Past what its lockfile is still open to (module/ricebox/make/advisories.sh): crossbeam-epoch (RUSTSEC-2026-0204).
lifts="crossbeam-epoch=0.9.20"
build() {
  cargo build --release --locked --target "$target"
  install -D -m 0755 "$CARGO_TARGET_DIR/$target/release/fd" "$dest/usr/bin/fd"
}
check() {
  f="$dest/usr/bin/fd"
  [ "$("$f" --version)" = "fd $FD_VERSION" ]
  mkdir -p t/.git t/src t/build
  echo build > t/.gitignore
  touch t/src/a.ts t/build/b.ts t/src/c.md
  [ "$(cd t && "$f" -e ts)" = src/a.ts ]
}
