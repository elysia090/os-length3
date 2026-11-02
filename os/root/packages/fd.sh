# fd: files found by their names, skipping what .gitignore and hidden files say to; what find is reached for.
pins="FD"
tools="rust cargo"
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
