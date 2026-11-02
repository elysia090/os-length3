# hyperfine: commands timed against each other, with warm-up runs, statistics and the outliers said.
pins="HYPERFINE"
tools="rust cargo"
build() {
  cargo build --release --locked --target "$target"
  install -D -m 0755 "$CARGO_TARGET_DIR/$target/release/hyperfine" "$dest/usr/bin/hyperfine"
}
check() {
  h="$dest/usr/bin/hyperfine"
  [ "$("$h" --version)" = "hyperfine $HYPERFINE_VERSION" ]
  "$h" --style basic -N --runs 3 --export-json h.json true > /dev/null && grep -q '"command": "true"' h.json
}
