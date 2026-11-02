# delta: git's diffs, logs and blames with syntax colour, the words changed within a line marked, and line numbers;
# what git pages through (core.pager in the root's /etc/gitconfig). Its git (libgit2) and its syntaxes' regular
# expressions (Oniguruma) are crates' own copies, built here.
pins="DELTA"
tools="rust cargo"
build() {
  cargo build --release --locked --target "$target"
  install -D -m 0755 "$CARGO_TARGET_DIR/$target/release/delta" "$dest/usr/bin/delta"
}
check() {
  d="$dest/usr/bin/delta"
  "$d" --version | grep -q "^delta $DELTA_VERSION"
  # A diff given it comes out with the line changed in it, coloured.
  e=$(printf '\033')
  printf -- '--- a/f.rs\n+++ b/f.rs\n@@ -1 +1 @@\n-let a = 1;\n+let a = 2;\n' | "$d" --no-gitconfig --paging=never > o
  grep -q "$e\[" o && sed "s/$e\[[0-9;]*m//g" o | grep -q 'let a = 2;'
}
