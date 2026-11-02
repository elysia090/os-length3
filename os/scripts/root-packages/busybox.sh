# BusyBox: the shell and the small tools, as busybox.config says them (what a package of the root gives in full is
# not an applet; nothing of a machine that boots is). KCONFIG_NOTIMESTAMP leaves the build's time out of its banner.
pins="BUSYBOX"
inputs="os/scripts/root-packages/busybox.config"
build() {
  export KCONFIG_NOTIMESTAMP=1
  make allnoconfig
  while IFS= read -r line; do
    case $line in
      CONFIG_*=n) k=${line%%=*}; sed -i -e "/^$k=/d" -e "/^# $k is not set\$/d" .config; echo "# $k is not set" >> .config ;;
      CONFIG_*=*) k=${line%%=*}; sed -i -e "/^$k=/d" -e "/^# $k is not set\$/d" .config; echo "$line" >> .config ;;
    esac
  done < "$recipes/busybox.config"
  make oldconfig < /dev/null
  make -j"$jobs" CC=gcc
  make CC=gcc CONFIG_PREFIX="$dest" install
}
check() {
  b="$dest/usr/bin/busybox"
  "$b" | head -1 | grep -q "^BusyBox v$BUSYBOX_VERSION () multi-call binary"
  [ "$("$b" sh -c 'x=1; echo $((x + 1))')" = 2 ]
  for a in mount umount dmesg blkid fdisk ip clear reset init poweroff; do ! "$b" --list | grep -qx "$a"; done
}
