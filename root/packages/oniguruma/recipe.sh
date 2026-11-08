# Oniguruma: the regular expressions jq's test, match, capture, sub and gsub are made of; its headers, archive and
# pkg-config file.
pins="ONIGURUMA"
build() {
  ./configure --prefix=/usr --disable-shared --enable-static
  make -j"$jobs" LDFLAGS="$allstatic"
  make DESTDIR="$dest" LDFLAGS="$allstatic" install
}
check() {
  # A program built against it finds what a pattern says.
  printf '%s\n' '#include <oniguruma.h>' '#include <string.h>' 'int main(void) {' \
    '  OnigEncoding e[] = {ONIG_ENCODING_UTF8}; regex_t *re; OnigErrorInfo info; onig_initialize(e, 1);' \
    '  const UChar *p = (const UChar *)"[0-9]+", *s = (const UChar *)"web-42";' \
    '  if (onig_new(&re, p, p + strlen((const char *)p), ONIG_OPTION_DEFAULT, ONIG_ENCODING_UTF8, ONIG_SYNTAX_DEFAULT, &info)) return 2;' \
    '  return onig_search(re, s, s + 6, s, s + 6, NULL, ONIG_OPTION_NONE) != 4; }' > o.c
  gcc -static -I"$dest/usr/include" -o o o.c -L"$dest/usr/lib" -lonig && ./o
}
