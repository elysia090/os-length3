# ripgrep (rg): a tree searched, skipping what .gitignore and hidden files say to, by Rust's regex engine; its own
# allocator on musl (jemalloc, a crate's copy built here). Perl's regular expressions (-P) are left out: PCRE2 would
# be one more copy of a library, its JIT making code as it runs. Its settings as the root has them: /etc/ripgreprc
# (module/ricebox/etc), read by it in its check.
pins="RIPGREP"
tools="rust cargo"
inputs="etc/ripgreprc"
build() {
  cargo build --release --locked --target "$target"
  install -D -m 0755 "$CARGO_TARGET_DIR/$target/release/rg" "$dest/usr/bin/rg"
  install -D -m 0644 "$here/etc/ripgreprc" "$dest/etc/ripgreprc"
}
check() {
  r="$dest/usr/bin/rg"
  "$r" --version | head -n 1 | grep -q "^ripgrep $RIPGREP_VERSION"
  mkdir -p t/.git t/src t/build
  echo build > t/.gitignore
  echo 'let needle = 1;' > t/src/a.ts
  echo needle > t/build/b.ts
  echo needle > t/src/c.md
  [ "$(cd t && "$r" -l --type ts needle)" = src/a.ts ]
  # With the root's settings, a pattern in lower case matches either case.
  echo 'let Needle = 2;' > t/src/d.ts
  [ "$(cd t && RIPGREP_CONFIG_PATH="$dest/etc/ripgreprc" "$r" -l --type ts needle | sort | tr '\n' ' ')" = 'src/a.ts src/d.ts ' ]
}
