# yq: jq's way of asking, for YAML (and TOML, XML, CSV and JSON), its comments and order kept when it writes.
pins="YQ"
tools="go"
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
