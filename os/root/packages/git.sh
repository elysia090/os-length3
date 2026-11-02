# git: no runtime languages (perl, python, tcl) and nothing it would reach for that the root has not; over the root's
# curl, OpenSSL and zlib. Its Rust parts are optional until Git 3.0 (NO_RUST), and building them would bring a Rust
# toolchain to the root's build for what C does as well: they are left out, and Git 3.0 is when that changes.
pins="GIT"
needs="zlib openssl curl"
build() {
  set -- prefix=/usr NO_RUST=YesPlease NO_GETTEXT=YesPlease NO_TCLTK=YesPlease NO_PERL=YesPlease NO_PYTHON=YesPlease \
    NO_EXPAT=YesPlease NO_REGEX=NeedsStartEnd OPENSSLDIR="$deps/usr" \
    CFLAGS="$CFLAGS $CPPFLAGS" LDFLAGS="$LDFLAGS" CURL_CFLAGS="$CPPFLAGS" \
    CURL_LDFLAGS="-L$deps/usr/lib -lcurl -lssl -lcrypto -lz -pthread" OPENSSL_LINK="-L$deps/usr/lib"
  make -j"$jobs" "$@" all
  make "$@" DESTDIR="$dest" install
}
check() {
  g="$dest/usr/bin/git"
  "$g" --version | grep -qx "git version $GIT_VERSION"
  export HOME=$PWD GIT_EXEC_PATH="$dest/usr/libexec/git-core"
  "$g" init -q r && cd r && echo one > f && "$g" add f
  "$g" -c user.name=t -c user.email=t@t commit -qm one && [ "$("$g" log --format=%s)" = one ]
}
