# otter: what a Prompt has, and what each thing is: `help` in the Prompt's shell (/etc/length3/shrc), and whatis and
# apropos by their links. Made from this repository's own source (kernel/otter/otter.c, a unit of C with no C library,
# on kernel/lib's three headers, its own checks in kernel/otter/test), with the table it reads
# (root/etc/length3/commands, which os/scripts/commands.ts writes from what each command did under the browser's kernel
# and natively) and the root's tldr pages for what each thing is.
version=1
inputs="../../kernel/lib/word.h ../../kernel/lib/sys.h ../../kernel/lib/io.h ../../kernel/lib/build.sh ../../kernel/otter/otter.c
  ../../kernel/otter/test/otter.sh etc/length3/commands"
build() {
  mkdir -p "$dest/usr/bin"
  sh "$here/../../kernel/lib/build.sh" "$here/../../kernel/otter/otter.c" "$dest/usr/bin/otter"
  ln -s otter "$dest/usr/bin/whatis"
  ln -s otter "$dest/usr/bin/apropos"
  install -D -m 0644 "$here/etc/length3/commands" "$dest/etc/length3/commands"
}
# Its checks, then the table it ships read whole: every kind it names one otter shows.
check() {
  sh "$here/../../kernel/otter/test/otter.sh" "$dest/usr/bin/otter"
  OTTER_TABLE="$dest/etc/length3/commands" "$dest/usr/bin/otter" > catalog
  grep -q '^core ' catalog && grep -q '^builtins ' catalog
}
