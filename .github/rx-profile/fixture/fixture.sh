#!/bin/sh
# Shipped tools are read-only. Fresh isolated /tmp per trial. Boundary prints are out of measured time.
set -eu
umask 022
cp /tmp/rx-in/edit_distance-A.cc edit_distance.cc
cp /tmp/rx-in/build.ninja /tmp/rx-in/driver.cc /tmp/rx-in/edit_distance.h /tmp/rx-in/string_piece.h .
ninja=/tmp/rx-in/ninja; timer=/tmp/rx-in/rx-time
[ "$("$ninja" --version)" = 1.13.2 ]
"$ninja" -j1 proof
[ "$(./proof kitten sitten)" = 1 ]
printf 'RX_A\n'; sha256sum edit_distance.o driver.o proof
# Both native and Sods need a strictly increasing source timestamp, regardless of host clock precision.
sleep 0.02
cp /tmp/rx-in/edit_distance-B.cc edit_distance.cc
printf 'RX_B_START\n'
"$timer" "$ninja"
printf 'RX_B_END\n'
[ "$(./proof kitten sitten)" = 2 ]
printf 'RX_B\n'; sha256sum edit_distance.o driver.o proof
printf 'RX_NINJA_LOG\n'; cat .ninja_log
printf 'RX_NINJA_DEPS\n'; "$ninja" -t deps edit_distance.o
prior_log=$(sha256sum .ninja_log)
printf 'RX_INVALID\n'
sleep 0.02
printf '%s\n' 'this is not a declaration;' > edit_distance.cc
rc=0; "$ninja" -j1 proof || rc=$?
[ "$rc" = 1 ]
[ "$prior_log" = "$(sha256sum .ninja_log)" ]
printf 'RX_INVALID_STATUS %d\n' "$rc"
printf 'RX_AFTER_INVALID\n'; sha256sum edit_distance.o driver.o proof
printf 'RX_DONE\n'
