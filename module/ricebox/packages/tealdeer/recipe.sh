# tldr (tealdeer), with tldr-pages in English and Japanese: a command's common uses, as examples, read offline from
# /usr/share/tldr; its settings as the root has them, /etc/tealdeer (module/ricebox/etc; the root's shrc names them), which
# update nothing by themselves.
# `tldr --update` fetches newer pages over TLS by rustls, a crate, trusting the root's CA bundle.
pins="TEALDEER TLDR_PAGES_EN TLDR_PAGES_JA"
tools="rust cargo"
# Past what its lockfile is still open to (module/ricebox/make/advisories.sh): rustix (RUSTSEC-2026-0486).
lifts="rustix=1.1.6"
inputs="etc/tealdeer/config.toml"
build() {
  cargo build --release --locked --target "$target"
  install -D -m 0755 "$CARGO_TARGET_DIR/$target/release/tldr" "$dest/usr/bin/tldr"
  p="$dest/usr/share/tldr/tldr-pages"
  unpack TLDR_PAGES_EN "$p/pages.en" flat
  unpack TLDR_PAGES_JA "$p/pages.ja" flat
  install -D -m 0644 "$here/etc/tealdeer/config.toml" "$dest/etc/tealdeer/config.toml"
}
check() {
  t="$dest/usr/bin/tldr"
  [ "$("$t" --version)" = "tealdeer $TEALDEER_VERSION" ]
  # Its pages read where they were put, in each language.
  mkdir -p c
  sed "s|\"/usr/share/tldr\"|\"$dest/usr/share/tldr\"|" "$dest/etc/tealdeer/config.toml" > c/config.toml
  export TEALDEER_CONFIG_DIR="$PWD/c"
  "$t" --raw tar | grep -q '^# tar'
  "$t" --raw -L ja tar | grep -q 'アーカイブ'
}
