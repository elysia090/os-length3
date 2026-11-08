# fzf: a fuzzy finder over any list it is given (files, history, branches), as a screen where it is on a terminal
# and as a filter where it is not.
pins="FZF"
tools="go"
# Past what its go.mod is still open to (root/make/advisories.sh): golang.org/x/sys (GO-2026-5024) and golang.org/x/text
# (GO-2026-5970, -6629).
lifts="golang.org/x/sys=v0.44.0 golang.org/x/text=v0.41.0"
build() {
  go build -ldflags "$golink -s -w -X main.version=$FZF_VERSION -X main.revision=" -o "$dest/usr/bin/fzf" .
}
check() {
  f="$dest/usr/bin/fzf"
  [ "$("$f" --version)" = "$FZF_VERSION" ]
  [ "$(printf 'lib/other.c\nweb-42/src/main.ts\nREADME.md\n' | "$f" --filter main.ts)" = web-42/src/main.ts ]
}
