# delta: git's diffs, logs and blames with syntax colour, the words changed within a line marked, and line numbers;
# what git pages through (core.pager in the root's /etc/gitconfig). Its git (libgit2) and its syntaxes' regular
# expressions (Oniguruma) are crates' own copies, built here.
pins="DELTA"
tools="rust cargo"
# Past what its lockfile is still open to (root/advisories.sh): anyhow (RUSTSEC-2026-0190), git2 (RUSTSEC-2026-0008),
# libz-sys (RUSTSEC-2026-0418), plist, whose 1.10 takes quick-xml past RUSTSEC-2026-0194 and -0195, rand
# (RUSTSEC-2026-0097), serde_with (GHSA-7gcf-g7xr-8hxj), time (RUSTSEC-2026-0009), and url, whose 2.5.4 takes idna past
# RUSTSEC-2024-0421.
lifts="anyhow=1.0.103 git2=0.20.4 libz-sys=1.1.31 plist=1.10.3 rand=0.8.6 serde_with=3.21.0 time=0.3.47 url=2.5.4"
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
