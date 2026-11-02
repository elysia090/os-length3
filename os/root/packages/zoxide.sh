# zoxide (z): cd by a part of a directory's name, to the one most used there. Its setup for sh, what `zoxide init
# posix` says, is made here once (/usr/share/zoxide/init.sh), for the root's shrc to read rather than run zoxide at
# every shell's start; z itself is the shrc's, over it. Each zoxide writes back the whole of what it keeps, a query
# too (it keeps it sorted), so one that read it before another wrote takes the other's back out: the shrc learns a
# place on its own time, and the place learnt by a `cd` went when the `z` after it looked one up. The patch has each
# hold it while it reads and writes it (zoxide edit's fzf runs zoxide again: the lock goes when it is saved); it is
# for this release, and another is reviewed before it is pinned.
pins="ZOXIDE"
tools="rust cargo"
patches="zoxide/0.10.0-lock.patch"
# Past what its lockfile is still open to (root/advisories.sh): anyhow (RUSTSEC-2026-0190).
lifts="anyhow=1.0.103"
build() {
  [ "$ZOXIDE_VERSION" = 0.10.0 ] || { echo "zoxide $ZOXIDE_VERSION: review zoxide/0.10.0-lock.patch"; exit 1; }
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
  # One that finds what it keeps held by another waits for it, and what both learnt is kept.
  mkdir d/third
  exec 9>> zd/db.zo.lock
  flock 9
  "$z" add "$PWD/d/third" 9>&- &
  sleep 1
  not grep -q third zd/db.zo
  exec 9>&-
  wait $!
  [ "$("$z" query third)" = "$PWD/d/third" ]
  [ "$("$z" query web)" = "$PWD/d/projects/web-42" ]
  # Its setup for sh is sh, and gives what the shrc's z is made of.
  sh -n "$dest/usr/share/zoxide/init.sh"
  grep -q '^__zoxide_z()' "$dest/usr/share/zoxide/init.sh"
}
