# The time zones, compiled by the zic of tzcode at the same release (built here, not shipped), with the tables
# beside them, as the base had them.
pins="TZDATA TZCODE"
flat=1
build() {
  [ "$TZCODE_VERSION" = "$TZDATA_VERSION" ] || { echo "tzcode $TZCODE_VERSION is not tzdata $TZDATA_VERSION"; exit 1; }
  unpack TZCODE "$PWD/../code" flat
  make -C ../code CFLAGS='-O2' VERSION="$TZCODE_VERSION" VERSION_DEPS= zic
  make VERSION="$TZDATA_VERSION" VERSION_DEPS= PACKRATDATA=backzone PACKRATLIST=zone.tab tzdata.zi
  zoneinfo="$dest/usr/share/zoneinfo"
  mkdir -p "$zoneinfo"
  ../code/zic -d "$zoneinfo" tzdata.zi
  install -m 644 iso3166.tab zone.tab zone1970.tab "$zoneinfo"
}
