# just: a project's commands, named in its justfile and run by those names, with what each needs first.
pins="JUST"
tools="rust cargo"
build() {
  cargo build --release --locked --target "$target"
  install -D -m 0755 "$CARGO_TARGET_DIR/$target/release/just" "$dest/usr/bin/just"
}
check() {
  j="$dest/usr/bin/just"
  [ "$("$j" --version)" = "just $JUST_VERSION" ]
  printf 'test: build\n    @echo tested\nbuild:\n    @echo built\n' > justfile
  [ "$("$j" test)" = "$(printf 'built\ntested')" ]
}
