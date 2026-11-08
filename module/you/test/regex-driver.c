/* regex.c, run as `rg -o` runs a pattern: each line of standard input, every match on it (an empty one too), one a
 * line (`-i`: case aside); or, `-l`, each line holding one, as `rg` prints them. For you/test/regex.sh, which
 * compares it with ripgrep's (and for timing it against ripgrep). */
#define UNIT "regex"
#define ARENA (1 << 27) /* the text (up to 64 MiB, read whole when not a file to map) and the DFAs */
#include "../../lib/io.h"
#include "../src/regex.c"
#include "../src/dfa.c"
#include "../src/grep.c"

static int main_(int argc, char **argv, char **envp) {
  (void)envp;
  int flags = 0, a = 1, whole = 0;
  for (; a < argc && argv[a][0] == '-' && argv[a][1] && !argv[a][2]; a++)
    if (argv[a][1] == 'i') flags |= RE_ICASE;
    else if (argv[a][1] == 'l') whole = 1;
    else break;
  if (a >= argc) fail("usage: regex-driver [-i] [-l] PATTERN < text", 0);
  struct re *r = re_compile((const u8 *)argv[a], (u32)slen(argv[a]), flags | RE_LINES);
  if (!r) fail("bad pattern: ", re_error);
  const u8 *in;
  u64 n = 0;
  int mapped = 0;
  struct kstat st;
  if (!sys2(SYS_fstat, 0, (i64)&st) && IS_REG(st.mode) && st.size > 0) {
    i64 m = sys6(SYS_mmap, 0, st.size, 1 /* PROT_READ */, 2 /* MAP_PRIVATE: its pages read in by each part's thread */, 0, 0);
    if (m < 0 && m > -4096) fail("cannot map the text", 0);
    in = (const u8 *)m, n = (u64)st.size, mapped = 1;
  } else {
    u8 *b = grab(1 << 26);
    for (i64 k; n < (1 << 26) && (k = sys3(SYS_read, 0, (i64)(b + n), (i64)((1 << 26) - n))) > 0;) n += (u64)k;
    in = b;
  }
  struct pieces *all = grep_all(r, in, n, !whole, mapped);
  for (u32 i = 0; i < all->n; i++) if (all->p[i].outn) put(all->p[i].out, all->p[i].outn);
  flush();
  return 0;
}
