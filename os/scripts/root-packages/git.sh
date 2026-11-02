# git: no runtime languages (perl, python, tcl), nothing the base's leaves out, its paths as the base has them; a
# static PIE, hardened, over curl and OpenSSL.
pins="GIT"
needs="zlib openssl curl"
build() {
  set -- prefix=/usr NO_GETTEXT=YesPlease NO_TCLTK=YesPlease NO_PERL=YesPlease NO_PYTHON=YesPlease \
    NO_EXPAT=YesPlease NO_REGEX=NeedsStartEnd OPENSSLDIR="$deps/usr" \
    CFLAGS="$hard -fPIE -I$deps/usr/include" LDFLAGS="$pie -L$deps/usr/lib" CURL_CFLAGS="-I$deps/usr/include" \
    CURL_LDFLAGS="-L$deps/usr/lib -lcurl -lssl -lcrypto -lz -pthread" OPENSSL_LINK="-L$deps/usr/lib"
  make -j"$jobs" "$@" all
  make "$@" DESTDIR="$dest" install
}
