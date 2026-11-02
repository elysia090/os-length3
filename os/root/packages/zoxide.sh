# zoxide (z): cd by a part of a directory's name, to the one most used there. Its setup for sh, what `zoxide init
# posix` says, is made here once (/usr/share/zoxide/init.sh), for the root's shrc to read rather than run zoxide at
# every shell's start; z itself is the shrc's, over it.
pins="ZOXIDE"
tools="rust cargo"
build() {
  cargo build --release --locked --target "$target"
  z="$CARGO_TARGET_DIR/$target/release/zoxide"
  install -D -m 0755 "$z" "$dest/usr/bin/zoxide"
  mkdir -p "$dest/usr/share/zoxide"
  "$z" init posix --no-cmd --hook none > "$dest/usr/share/zoxide/init.sh"
}
check() {
  z="$dest/usr/bin/zoxide"
  "$z" --version | grep -q "$ZOXIDE_VERSION"
  mkdir -p d/projects/web-42 d/other
  export _ZO_DATA_DIR="$PWD/zd"
  "$z" add "$PWD/d/projects/web-42" "$PWD/d/other"
  [ "$("$z" query web)" = "$PWD/d/projects/web-42" ]
  # Its setup for sh is sh, and gives what the shrc's z is made of.
  sh -n "$dest/usr/share/zoxide/init.sh"
  grep -q '^__zoxide_z()' "$dest/usr/share/zoxide/init.sh"
}
