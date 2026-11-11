# lazygit: git's staging (by line), commits, branches, rebases, stashes and conflicts, in one screen; its diffs
# through delta, by its settings as the root has them: /etc/xdg/lazygit/config.yml (module/ricebox/etc), where it looks.
pins="LAZYGIT"
tools="go"
inputs="etc/xdg/lazygit/config.yml"
build() {
  go build -ldflags "$golink -s -w -X main.version=$LAZYGIT_VERSION -X main.buildSource=length3" \
    -o "$dest/usr/bin/lazygit" .
  install -D -m 0644 "$here/etc/xdg/lazygit/config.yml" "$dest/etc/xdg/lazygit/config.yml"
}
check() {
  "$dest/usr/bin/lazygit" --version | grep -q "build source=length3, version=$LAZYGIT_VERSION,"
}
