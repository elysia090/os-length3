# age: files encrypted to a key, a passphrase or an SSH key (age, age-keygen); small keys, no settings to get wrong.
pins="AGE"
tools="go"
build() {
  go build -ldflags "$golink -s -w -X main.Version=v$AGE_VERSION" -o "$dest/usr/bin/" ./cmd/age ./cmd/age-keygen
}
check() {
  a="$dest/usr/bin/age"
  [ "$("$a" --version)" = "v$AGE_VERSION" ]
  # What is encrypted to a key made here is read back by that key alone.
  "$dest/usr/bin/age-keygen" -o key 2> /dev/null
  echo made | "$a" -r "$("$dest/usr/bin/age-keygen" -y key)" -o m.age && [ "$("$a" -d -i key m.age)" = made ]
}
