# bat: a file shown with its syntax coloured, its lines numbered and git's changes in its margin, paged by less when
# it is longer than the screen; cat where it is not on a terminal. Its git (libgit2) and its syntaxes' regular
# expressions (Oniguruma) are crates' own copies, built here.
pins="BAT"
tools="rust cargo"
# Past what its lockfile is still open to (root/make/advisories.sh): anyhow (RUSTSEC-2026-0190), crossbeam-epoch
# (RUSTSEC-2026-0204), git2 (RUSTSEC-2026-0008), libz-sys (RUSTSEC-2026-0418), plist, whose 1.10 takes quick-xml past
# RUSTSEC-2026-0194 and -0195, serde_with (GHSA-7gcf-g7xr-8hxj) and time (RUSTSEC-2026-0009).
lifts="anyhow=1.0.103 crossbeam-epoch=0.9.20 git2=0.20.4 libz-sys=1.1.31 plist=1.10.3 serde_with=3.21.0 time=0.3.47"
build() {
  cargo build --release --locked --target "$target"
  install -D -m 0755 "$CARGO_TARGET_DIR/$target/release/bat" "$dest/usr/bin/bat"
}
check() {
  b="$dest/usr/bin/bat"
  "$b" --version | grep -q "^bat $BAT_VERSION"
  printf 'fn main() {}\n' > m.rs
  [ "$("$b" m.rs)" = 'fn main() {}' ]
  "$b" --color=always --paging=never --style=plain m.rs | grep -q "$(printf '\033')\[38;"
}
