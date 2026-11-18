# SQLite and its shell, sqlite3 (its lines edited by the root's readline); with full-text search (FTS5), R*Trees,
# sessions and the rest of what --all brings; its header, archive and pkg-config file.
pins="SQLITE"
needs="readline ncurses"
# Its pin is the number SQLite's download names (3XXYYZZ); its version is what that number says.
version=$(echo "$SQLITE_VERSION" | awk '{ printf "%d.%d.%d", substr($0, 1, 1), substr($0, 2, 2), substr($0, 4, 2) }')
build() {
  # Its shell is compiled by where it is (in an assertion's words): from the top.
  export CFLAGS="$CFLAGS -ffile-prefix-map=$PWD/="
  ./configure --prefix=/usr --disable-shared --static-cli-shell --all \
    --with-readline-cflags="-I$deps/usr/include" --with-readline-ldflags="-L$deps/usr/lib -lreadline -lncursesw"
  make -j"$jobs"
  make DESTDIR="$dest" install
}
check() {
  s="$dest/usr/bin/sqlite3"
  "$s" -version | grep -q "^$version "
  [ "$("$s" :memory: "create virtual table t using fts5(x); insert into t values ('made here'), ('elsewhere');
    select x from t where t match 'made'; select json_extract('{\"a\":[1,2]}', '\$.a[1]');")" = "$(printf 'made here\n2')" ]
  # Its shell edits its lines with readline (which reads ~/.inputrc).
  grep -q inputrc "$s"
}
