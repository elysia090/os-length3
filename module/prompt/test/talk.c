/*
 * What is at the other end of a Prompt, for prompt's test (prompt.sh): it says the size its terminal has, then
 * answers each line typed to it, and ends as it is told to. On lib, with no C library, so a bundle's root is this
 * one file.
 *
 *   ready ROWS COLUMNS        as it starts
 *   size                      -> size ROWS COLUMNS, as the terminal is then
 *   exit N                    ends, N
 *   anything else             -> you said: anything else
 */
#define UNIT "talk"
#include "../../lib/io.h"

enum { SYS_ioctl = 16 };

static void say(const char *s) { put(s, slen(s)); }
static void number(u64 v) {
  u8 t[24], *p = piece();
  u32 n = 0, k = 0;
  do t[n++] = (u8)('0' + v % 10); while (v /= 10);
  while (n) p[k++] = t[--n];
  put(p, k);
}
static void size(const char *word) {
  u16 size[4] = {0, 0, 0, 0};
  sys3(SYS_ioctl, 0, 0x5413 /* TIOCGWINSZ */, (i64)size);
  say(word), say(" "), number(size[0]), say(" "), number(size[1]), say("\n"), flush();
}

static int main_(int argc, char **argv, char **envp) {
  (void)argc, (void)argv, (void)envp;
  size("ready");
  u8 *line = grab(4096);
  for (;;) {
    i64 n = sys3(SYS_read, 0, (i64)line, 4095);
    if (n <= 0) return 0; /* (what was typed has ended) */
    while (n > 0 && (line[n - 1] == '\n' || line[n - 1] == '\r')) n--;
    line[n] = 0;
    if (same((char *)line, "size")) size("size");
    else if (line[0] == 'e' && line[1] == 'x' && line[2] == 'i' && line[3] == 't' && line[4] == ' ') {
      int code = 0;
      for (u8 *d = line + 5; *d >= '0' && *d <= '9'; d++) code = code * 10 + (*d - '0');
      return code;
    } else say("you said: "), put(line, (u64)n), say("\n"), flush();
  }
}
