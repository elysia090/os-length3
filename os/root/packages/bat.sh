# bat: a file shown with its syntax coloured, its lines numbered and git's changes in its margin, paged by less when
# it is longer than the screen; cat where it is not on a terminal. Its git (libgit2) and its syntaxes' regular
# expressions (Oniguruma) are crates' own copies, built here.
pins="BAT"
tools="rust cargo"
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
