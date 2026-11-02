# fzf: a fuzzy finder over any list it is given (files, history, branches), as a screen where it is on a terminal
# and as a filter where it is not.
pins="FZF"
tools="go"
build() {
  go build -ldflags "$golink -s -w -X main.version=$FZF_VERSION -X main.revision=" -o "$dest/usr/bin/fzf" .
}
check() {
  f="$dest/usr/bin/fzf"
  [ "$("$f" --version)" = "$FZF_VERSION" ]
  [ "$(printf 'lib/other.c\nweb-42/src/main.ts\nREADME.md\n' | "$f" --filter main.ts)" = web-42/src/main.ts ]
}
