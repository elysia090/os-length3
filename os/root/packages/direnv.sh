# direnv: a directory's .envrc loaded on entering it and unloaded on leaving it, once allowed (direnv allow); its
# stdlib run by the root's bash.
pins="DIRENV"
# bash: for its check, the build machine's (DIRENV_BASH: Alpine keeps it in /bin, the root in /usr/bin).
tools="go bash"
build() {
  go build -ldflags "$golink -s -w -X main.bashPath=/usr/bin/bash" -o "$dest/usr/bin/direnv" .
}
check() {
  d="$dest/usr/bin/direnv"
  [ "$("$d" version)" = "$DIRENV_VERSION" ]
  # An .envrc is nothing until allowed; allowed, it is what the environment becomes there.
  export HOME="$PWD" XDG_DATA_HOME="$PWD/data" XDG_CONFIG_HOME="$PWD/config" DIRENV_BASH="$(command -v bash)"
  mkdir p
  echo 'export MADE=here' > p/.envrc
  (cd p && "$d" export json 2> /dev/null) | not grep -q MADE
  (cd p && "$d" allow . && "$d" export json 2> /dev/null) | grep -q '"MADE": *"here"'
}
