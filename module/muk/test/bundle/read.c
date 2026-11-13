/* config.json parsing alone: read FILE, repeat N times, print ns/run and a result checksum.
 * Built twice by read.sh: the same code and input, atomic and serial arenas. No namespaces are made.
 */
#define UNIT "muk-read"
#define ARENA (4 << 20)
#include "../../../lib/io.h"
#include "../../src/bundle.h"

static u8 input[1 << 20], config_text[(1 << 20) + 16];
static u64 tick(void) {
  struct { i64 s, ns; } t;
  if (sys2(SYS_clock_gettime, 1, (i64)&t) < 0) fail("clock", "");
  return (u64)t.s * 1000000000ull + (u64)t.ns;
}
static int main_(int argc, char **argv, char **envp) {
  (void)envp;
  if (argc != 3) fail("usage: ", "muk-read FILE N");
  u64 count = 0;
  for (char *p = argv[2]; *p; p++) { if (*p < '0' || *p > '9' || count > 10000000) fail("N", ""); count = count * 10 + (u64)(*p - '0'); }
  if (!count) fail("N", "");
  i64 fd = sys3(SYS_open, (i64)argv[1], O_RDONLY, 0), n;
  if (fd < 0 || (n = sys3(SYS_read, fd, (i64)input, sizeof input)) < 0 || (u64)n == sizeof input) fail("input", "");
  sys1(SYS_close, fd);
  u64 checksum = 0, start = tick();
  for (u64 i = 0; i < count; i++) {
    used = 0;
    __builtin_memset(&c, 0, sizeof c);
    __builtin_memcpy(config_text, input, (u64)n);
    __builtin_memset(config_text + n, 0, 16);
    j = config_text; jend = config_text + n;
    config(0, ID);
    checksum += c.nmounts + c.nargs + c.spaces;
  }
  u64 elapsed = tick() - start;
  u8 *out = piece(), *end = out + 32;
  u64 value = elapsed / count;
  do *--end = (u8)('0' + value % 10); while (value /= 10);
  put(end, (u64)(out + 32 - end)); put(" ", 1);
  out = piece(); end = out + 32;
  do *--end = (u8)('0' + checksum % 10); while (checksum /= 10);
  put_line(end, (u64)(out + 32 - end)); flush(); return 0;
}
