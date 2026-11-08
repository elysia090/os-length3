# BusyBox: the shell and the small tools, each whole, as busybox.config names them (what a package of the root gives
# in full is not an applet; nothing of a machine that boots is). KCONFIG_NOTIMESTAMP leaves the build's time out of
# its banner.
pins="BUSYBOX"
inputs="packages/busybox/busybox.config"
patches="split-include-fgets.patch"
build() {
  export KCONFIG_NOTIMESTAMP=1
  # An applet is what a source file declares with //applet:IF_NAME(...): NAME is the setting that builds it.
  applets=$(find . -name '*.c' -exec grep -hoE '^//applet:IF_[A-Z0-9_]+\(' {} + | sed 's|^//applet:IF_||; s|($||' | sort -u)
  [ "$(echo "$applets" | wc -l)" -gt 300 ] || { echo "found $(echo "$applets" | wc -l) applets in BusyBox's sources"; exit 1; }
  put() {
    k=${1%%=*}
    sed -i -e "/^$k=/d" -e "/^# $k is not set\$/d" .config
    case $1 in *=n) echo "# $k is not set" ;; *) echo "$1" ;; esac >> .config
  }
  make defconfig
  for a in $applets; do put "CONFIG_$a=n"; done
  while IFS= read -r line; do case $line in CONFIG_*=*) put "$line" ;; esac; done < "$recipes/busybox.config"
  make oldconfig < /dev/null
  # Every applet named is made, and no other (one whose own needs are not met would be dropped without a word).
  for a in $applets; do grep -qx "CONFIG_$a=y" "$recipes/busybox.config" && echo "$a"; done > asked
  for a in $applets; do grep -qx "CONFIG_$a=y" .config && echo "$a"; done > made
  diff asked made || { echo "busybox.config's applets (<) and those made (>) differ"; exit 1; }
  make -j"$jobs" CC=gcc
  make CC=gcc CONFIG_PREFIX="$dest" install
}
check() {
  b="$dest/usr/bin/busybox"
  "$b" | "$b" head -n 1 | grep -q "^BusyBox v$BUSYBOX_VERSION () multi-call binary"
  [ "$("$b" sh -c 'x=1; echo $((x + 1))')" = 2 ]
  # Its tools as scripts written elsewhere use them: sort keys, head -N, awk's fields, find's tests and -exec, long
  # options. (grep is GNU grep's package.)
  printf 'b 2\na 1\nc 3\n' > t
  [ "$("$b" sort -k2,2n t | "$b" head -1)" = 'a 1' ]
  [ "$("$b" awk '$2 > 1 { printf "%s", $1 }' t)" = bc ]
  [ "$("$b" find . -maxdepth 1 -type f -name t -exec "$b" wc -l {} +)" = '3 ./t' ]
  "$b" mkdir --parents p/q
  "$b" cp --recursive p r
  "$b" ls --color=never -A r | grep -qx q
  # Not here: what a package has whole, what only a booting machine has, servers, logins, an unchecked TLS.
  for a in tar grep less gzip mount ip clear strings init modprobe mdev httpd crond su passwd wget hush man; do
    "$b" --list | not grep -qx "$a"
  done
}
