# otter: what a Prompt has, and what each thing is: `help` in the Prompt's shell (/etc/length3/shrc), and whatis and
# apropos by their links. Made from this repository's own source (otter/src/otter.c, a unit of C with no C library,
# on lib's three headers, its own checks in otter/test), with the table it reads
# (root/etc/length3/commands, which scripts/commands.ts writes from what each command did under the browser's kernel
# and natively) and the root's tldr pages for what each thing is.
version=1
inputs="../module/lib/word.h ../module/lib/sys.h ../module/lib/io.h ../module/lib/build.sh ../module/otter/src/otter.c
  ../module/otter/test/otter.sh etc/length3/commands"
build() {
  mkdir -p "$dest/usr/bin"
  sh "$here/../module/lib/build.sh" "$here/../module/otter/src/otter.c" "$dest/usr/bin/otter"
  ln -s otter "$dest/usr/bin/whatis"
  ln -s otter "$dest/usr/bin/apropos"
  install -D -m 0644 "$here/etc/length3/commands" "$dest/etc/length3/commands"
}
# Its checks, then the table it ships read whole: every kind it names one otter shows.
check() {
  sh "$here/../module/otter/test/otter.sh" "$dest/usr/bin/otter"
  OTTER_TABLE="$dest/etc/length3/commands" "$dest/usr/bin/otter" > catalog
  grep -q '^core ' catalog && grep -q '^builtins ' catalog
}
