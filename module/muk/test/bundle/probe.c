/*
 * What a box is, said from inside it: who the process is and what it may do, where it is, what is mounted and what is
 * in /dev. muk's test (muk.sh) runs it in a bundle under muk and under runc, and the two say the same. On lib, with no
 * C library, so a bundle's root is this one file.
 */
#define UNIT "probe"
#include "../../../lib/io.h"

enum { SYS_readlink = 89, SYS_getuid = 102, SYS_getgid = 104, SYS_getpid = 39, SYS_uname = 63, SYS_prlimit64 = 302, SYS_getgroups = 115 };

static void say(const char *s) { put(s, slen(s)); }
static void number(u64 v, u32 base) {
  u8 t[24], *p = piece();
  u32 n = 0, k = 0;
  do t[n++] = (u8)("0123456789abcdef"[v % base]); while (v /= base);
  while (n) p[k++] = t[--n];
  put(p, k);
}
/* The lines of a file of /proc that begin with one of `keys` (NUL after NUL), or all of them, each given to `line`. */
static void lines_of(const char *path, const char *keys, void (*line)(u8 *, u8 *)) {
  i64 fd = sys3(SYS_open, (i64)path, O_RDONLY, 0);
  if (fd < 0) { say(path), say(": not read\n"); return; }
  u8 *text = grab(1 << 16);
  i64 n = 0, r;
  while (n < (1 << 16) - 1 && (r = sys3(SYS_read, fd, (i64)(text + n), (1 << 16) - 1 - n)) > 0) n += r;
  sys1(SYS_close, fd);
  for (u8 *l = text, *end = text + n; l < end;) {
    u8 *e = l;
    while (e < end && *e != '\n') e++;
    int wanted = !keys;
    for (const char *k = keys; k && *k; k += slen(k) + 1) wanted |= (u64)(e - l) >= slen(k) && eq(l, (const u8 *)k, (u32)slen(k));
    if (wanted) line(l, e);
    l = e + 1;
  }
}
static void whole(u8 *l, u8 *e) { put(l, (u64)(e - l)), say("\n"); }
/* A line of mountinfo: where, how, and (after " - ") what kind. */
static void mounted(u8 *l, u8 *e) {
  u8 *f = l;
  for (int i = 0; i < 4 && f < e; f++) i += *f == ' ';
  u8 *g = f;
  for (int i = 0; i < 2 && g < e; g++) i += *g == ' ';
  u8 *kind = g - 1;
  while (kind + 3 < e && !(kind[0] == ' ' && kind[1] == '-' && kind[2] == ' ')) kind++;
  kind += 3;
  u8 *kind_end = kind;
  while (kind_end < e && *kind_end != ' ') kind_end++;
  say("mount "), put(f, (u64)(g - f)), put(kind, (u64)(kind_end - kind)), say("\n");
}

static int main_(int argc, char **argv, char **envp) {
  say("uid "), number((u64)sys1(SYS_getuid, 0), 10), say(" gid "), number((u64)sys1(SYS_getgid, 0), 10);
  say(" groups "), number((u64)sys2(SYS_getgroups, 0, 0), 10), say(" pid "), number((u64)sys1(SYS_getpid, 0), 10), say("\n");
  u8 *names = grab(6 * 65);
  sys1(SYS_uname, (i64)names);
  say("host "), say((char *)names + 65), say(" domain "), say((char *)names + 5 * 65), say("\n");
  u8 *cwd = grab(4096);
  sys2(SYS_getcwd, (i64)cwd, 4096);
  say("cwd "), say((char *)cwd), say("\n");
  for (int i = 0; i < argc; i++) say("arg "), say(argv[i]), say("\n");
  for (char **e = envp; *e; e++) say("env "), say(*e), say("\n");
  lines_of("/proc/self/status", "Cap\0NoNewPrivs\0Seccomp:\0", whole);
  u64 limit[2];
  sys4(SYS_prlimit64, 0, 7, 0, (i64)limit);
  say("nofile "), number(limit[0], 10), say(" "), number(limit[1], 10), say("\n");
  lines_of("/proc/self/mountinfo", 0, mounted);
  static const char nodes[] = "/dev/null\0/dev/zero\0/dev/full\0/dev/random\0/dev/urandom\0/dev/tty\0/dev/fd\0/dev/stdin\0/dev/stdout\0/dev/stderr\0/dev/ptmx\0";
  for (const char *path = nodes; *path; path += slen(path) + 1) {
    __attribute__((uninitialized)) struct kstat st;
    say(path);
    if (sys4(SYS_newfstatat, AT_FDCWD, (i64)path, (i64)&st, 0x100 /* AT_SYMLINK_NOFOLLOW */) < 0) { say(" none\n"); continue; }
    say(" "), number(st.mode, 8);
    if ((st.mode & 0170000) == 0020000) say(" "), number(st.rdev >> 8 & 0xfff, 10), say(":"), number(st.rdev & 0xff, 10);
    if ((st.mode & 0170000) == 0120000) {
      u8 *to = grab(256);
      i64 n = sys3(SYS_readlink, (i64)path, (i64)to, 255);
      say(" -> "), put(to, n > 0 ? (u64)n : 0);
    }
    say("\n");
  }
  i64 fd = sys3(SYS_open, (i64)"/made-by-probe", O_WRONLY | O_CREAT, 0600);
  say("write in / "), number(fd < 0 ? (u64)-fd : 0, 10), say("\n");
  if (fd >= 0) sys1(SYS_close, fd), sys1(SYS_unlink, (i64)"/made-by-probe");
  flush();
  return argc > 1 && same(argv[1], "seven") ? 7 : 0;
}
