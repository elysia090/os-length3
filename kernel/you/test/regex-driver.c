/* regex.c, run as `rg -o` runs a pattern: each line of standard input, every match on it that is not empty, one a
 * line (`-i`: case aside). For kernel/you/test/regex.sh, which compares it with ripgrep's. */
#define UNIT "regex"
#include "../../lib/io.h"
#include "../regex.c"

static int main_(int argc, char **argv, char **envp) {
  (void)envp;
  int flags = 0, a = 1;
  if (a < argc && same(argv[a], "-i")) flags |= RE_ICASE, a++;
  if (a >= argc) fail("usage: regex-driver [-i] PATTERN < text", 0);
  struct re *r = re_compile((const u8 *)argv[a], (u32)slen(argv[a]), flags);
  if (!r) fail("bad pattern: ", re_error);
  u8 *in = grab(1 << 20);
  u64 n = 0;
  for (i64 k; (k = sys3(SYS_read, 0, (i64)(in + n), (i64)((1 << 20) - n))) > 0;) n += (u64)k;
  for (u64 i = 0; i < n;) {
    u64 e = i;
    while (e < n && in[e] != '\n') e++;
    for (u64 at = 0, ms, me; at <= e - i && re_find(r, in + i, e - i, at, &ms, &me);) {
      if (me > ms) { put(in + i + ms, me - ms); put("\n", 1); at = me; }
      else at = me + 1;
    }
    i = e + 1;
  }
  flush();
  return 0;
}
