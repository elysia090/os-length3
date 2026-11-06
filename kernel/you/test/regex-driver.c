/* regex.c, run as `rg -o` runs a pattern: each line of standard input, every match on it (an empty one too), one a
 * line (`-i`: case aside); or, `-l`, each line holding one, as `rg` prints them. For kernel/you/test/regex.sh, which
 * compares it with ripgrep's (and for timing it against ripgrep). */
#define UNIT "regex"
#define ARENA (1 << 27) /* the text (up to 64 MiB, read whole when not a file to map) and the DFAs */
#include "../../lib/io.h"
#include "../regex.c"
#include "../dfa.c"
#include "../grep.c"

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
  struct kstat st;
  if (!sys2(SYS_fstat, 0, (i64)&st) && IS_REG(st.mode) && st.size > 0) {
    i64 m = sys6(SYS_mmap, 0, st.size, 1 /* PROT_READ */, 2 | 0x8000 /* MAP_PRIVATE, MAP_POPULATE: its pages at once */, 0, 0);
    if (m < 0 && m > -4096) fail("cannot map the text", 0);
    in = (const u8 *)m, n = (u64)st.size;
  } else {
    u8 *b = grab(1 << 26);
    for (i64 k; n < (1 << 26) && (k = sys3(SYS_read, 0, (i64)(b + n), (i64)((1 << 26) - n))) > 0;) n += (u64)k;
    in = b;
  }
  struct grep g;
  grep_init(&g, r);
  grep_text(&g, in, n);
  for (u64 ls; (ls = grep_line(&g)) < n;) {
    u64 le = line_end(in, n, ls);
    if (whole) { put(in + ls, le - ls); put("\n", 1); continue; }
    for (u64 x = ls, last = ~0ull, ms, me; grep_span(&g, ls, le, &x, &last, &ms, &me);) { put(in + ms, me - ms); put("\n", 1); }
  }
  flush();
  return 0;
}
