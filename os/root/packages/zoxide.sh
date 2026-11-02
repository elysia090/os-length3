# zoxide (z): cd by a part of a directory's name, to the one most used there; its database under /var/cache/zoxide
# (the root's shrc sets z up for ash).
pins="ZOXIDE"
tools="rust cargo"
build() {
  cargo build --release --locked --target "$target"
  install -D -m 0755 "$CARGO_TARGET_DIR/$target/release/zoxide" "$dest/usr/bin/zoxide"
}
check() {
  z="$dest/usr/bin/zoxide"
  "$z" --version | grep -q "$ZOXIDE_VERSION"
  mkdir -p d/projects/web-42 d/other
  export _ZO_DATA_DIR="$PWD/zd"
  "$z" add "$PWD/d/projects/web-42" "$PWD/d/other"
  [ "$("$z" query web)" = "$PWD/d/projects/web-42" ]
  "$z" init posix --cmd z | grep -q '^z()'
}
