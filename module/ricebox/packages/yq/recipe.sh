# yq: jq's way of asking, for YAML (and TOML, XML, CSV and JSON), its comments and order kept when it writes.
pins="YQ"
tools="go"
# Past what its go.mod is still open to (module/ricebox/make/advisories.sh): golang.org/x/net's html and HTTP/2 (GO-2026-6603, -6610,
# -6611, -6612, -6617, -6860, -6866).
lifts="golang.org/x/net=v0.62.0"
build() {
  go build -ldflags "$golink -s -w" -o "$dest/usr/bin/yq" .
}
check() {
  y="$dest/usr/bin/yq"
  "$y" --version | grep -q "version v$YQ_VERSION$"
  printf '# kept\na: {b: 1}\n' > f.yaml
  "$y" -i '.a.b = 2' f.yaml
  [ "$(cat f.yaml)" = "$(printf '# kept\na: {b: 2}')" ]
}
