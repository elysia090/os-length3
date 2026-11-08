# otter: what a Prompt has, and what each thing is: `help` in the Prompt's shell (/etc/length3/shrc), and whatis and
# apropos by their links. Made from this repository's own source (otter/otter.c, a unit of C with no C library,
# on lib's three headers, its own checks in otter/test), with the table it reads
# (root/etc/length3/commands, which os/scripts/commands.ts writes from what each command did under the browser's kernel
# and natively) and the root's tldr pages for what each thing is.
version=1
inputs="../../lib/word.h ../../lib/sys.h ../../lib/io.h ../../lib/build.sh ../../otter/otter.c
  ../../otter/test/otter.sh etc/length3/commands"
build() {
  mkdir -p "$dest/usr/bin"
  sh "$here/../../lib/build.sh" "$here/../../otter/otter.c" "$dest/usr/bin/otter"
  ln -s otter "$dest/usr/bin/whatis"
  ln -s otter "$dest/usr/bin/apropos"
  install -D -m 0644 "$here/etc/length3/commands" "$dest/etc/length3/commands"
}
# Its checks, then the table it ships read whole: every kind it names one otter shows.
check() {
  sh "$here/../../otter/test/otter.sh" "$dest/usr/bin/otter"
  OTTER_TABLE="$dest/etc/length3/commands" "$dest/usr/bin/otter" > catalog
  grep -q '^core ' catalog && grep -q '^builtins ' catalog
}
