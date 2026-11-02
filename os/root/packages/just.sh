# just: a project's commands, named in its justfile and run by those names, with what each needs first.
pins="JUST"
tools="rust cargo"
# Past what its lockfile is still open to (root/advisories.sh): pulldown-cmark (RUSTSEC-2026-0414, -0433).
lifts="pulldown-cmark=0.13.6"
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
