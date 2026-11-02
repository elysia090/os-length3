# jq, whole: its regular expressions (test, match, capture, sub, gsub) over the root's Oniguruma, and numbers kept
# as written (decNumber); with libjq.
pins="JQ"
needs="oniguruma"
build() {
  ./configure --prefix=/usr --disable-shared --enable-static --disable-docs --disable-maintainer-mode \
    --with-oniguruma=yes
  # jq --build-configuration repeats how it was configured: said as the root has it (what it was built against
  # is /usr there), as the builder says it in a text file.
  make src/config_opts.inc && sed -i "s|$deps||g" src/config_opts.inc
  make -j"$jobs" LDFLAGS="$allstatic"
  make DESTDIR="$dest" LDFLAGS="$allstatic" install
}
check() {
  [ "$(echo '{"a":[1,2,3],"n":"web-42","big":100000000000000000001}' | "$dest/usr/bin/jq" -c \
    '[(.a | add), (.n | test("[0-9]+")), (.n | sub("web-"; "")), .big]')" = '[6,true,"42",100000000000000000001]' ]
}
