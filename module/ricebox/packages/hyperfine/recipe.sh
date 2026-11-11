# hyperfine: commands timed against each other, with warm-up runs, statistics and the outliers said.
pins="HYPERFINE"
tools="rust cargo"
# Past what its lockfile is still open to (module/ricebox/make/advisories.sh): anyhow (RUSTSEC-2026-0190), bytes (RUSTSEC-2026-0007),
# rand 0.8 (RUSTSEC-2026-0097), rkyv (RUSTSEC-2026-0001) and rustix (RUSTSEC-2026-0486).
lifts="anyhow=1.0.103 bytes=1.11.1 rand@0.8.5=0.8.6 rkyv=0.7.46 rustix=1.1.6"
build() {
  cargo build --release --locked --target "$target"
  install -D -m 0755 "$CARGO_TARGET_DIR/$target/release/hyperfine" "$dest/usr/bin/hyperfine"
}
check() {
  h="$dest/usr/bin/hyperfine"
  [ "$("$h" --version)" = "hyperfine $HYPERFINE_VERSION" ]
  "$h" --style basic -N --runs 3 --export-json h.json true > /dev/null && grep -q '"command": "true"' h.json
}
