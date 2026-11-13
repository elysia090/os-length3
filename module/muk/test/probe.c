/*
 * What a box is, said from inside it: who the process is and what it may do, where it is, what is mounted and what is
 * in /dev. muk's test (muk.sh) runs it in a bundle under muk and under runc, and the two say the same. On lib, with no
 * C library, so a bundle's root is this one file.
 *
 *   probe [see:PATH]... [opens:PATH]... [asks:N[:A[:B]]]... [ptys] [forks:N] [seven] [wait]
 *
 * Each PATH seen: what it is, where it leads, its first line (or why it is not opened); opened: whether it opens to
 * be written (nothing is written), or why not. Each N: the kernel asked call number N (with A and B, else nothing),
 * and what it answered (0, or why not). `ptys`: how many terminals it is given before it is given no more;
 * `forks:N`: how many of N processes it starts. `seven` ends 7; `wait` ends when it is sent a signal, 128 + it.
 */
#define UNIT "probe"
#include "../../lib/io.h"

enum { SYS_rt_sigprocmask = 14, SYS_ioctl = 16, SYS_rt_sigtimedwait = 128, SYS_getpid = 39, SYS_uname = 63, SYS_fcntl = 72, SYS_readlink = 89, SYS_getuid = 102, SYS_getgid = 104, SYS_getgroups = 115, SYS_prlimit64 = 302 };

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

/* What a path is (not followed), where it leads if it is a link, and the first line of what is read there. */
static void see(const char *path) {
  __attribute__((uninitialized)) struct kstat st;
  say("see "), say(path);
  if (sys4(SYS_newfstatat, AT_FDCWD, (i64)path, (i64)&st, 0x100 /* AT_SYMLINK_NOFOLLOW */) < 0) { say(" none\n"); return; }
  say(" "), number(st.mode, 8);
  if ((st.mode & 0170000) == 0120000) {
    u8 *to = grab(256);
    i64 n = sys3(SYS_readlink, (i64)path, (i64)to, 255);
    say(" -> "), put(to, n > 0 ? (u64)n : 0);
  }
  i64 fd = sys3(SYS_open, (i64)path, O_RDONLY | O_NONBLOCK, 0);
  if (fd >= 0) {
    u8 *text = grab(256);
    i64 n = sys3(SYS_read, fd, (i64)text, 255), k = 0;
    while (k < n && text[k] != '\n') k++;
    if (n > 0) say(" = "), put(text, (u64)k);
    sys1(SYS_close, fd);
  } else say(" !"), number((u64)-fd, 10);
  say("\n");
}

/* A call made by its number, with up to two things asked of it, and the kernel's answer. */
static u64 count(const char **s) {
  u64 v = 0;
  while (**s >= '0' && **s <= '9') v = v * 10 + (u64)(*(*s)++ - '0');
  return v;
}
static void asks(const char *what) {
  const char *s = what;
  u64 nr = count(&s), a = 0, b = 0;
  if (*s == ':') s++, a = count(&s);
  if (*s == ':') s++, b = count(&s);
  i64 r = sys6((i64)nr, (i64)a, (i64)b, 0, 0, 0, 0);
  say("asks "), say(what), say(" "), number(r < 0 ? (u64)-r : 0, 10), say("\n");
}

/* A path opened to be written, and why it is not. */
static void opens(const char *path) {
  i64 fd = sys3(SYS_open, (i64)path, O_WRONLY, 0);
  say("opens "), say(path), say(" "), number(fd < 0 ? (u64)-fd : 0, 10), say("\n");
  if (fd >= 0) sys1(SYS_close, fd);
}
/* Terminals, one after another until there is no more (or a thousand). */
static void ptys(void) {
  u64 n = 0;
  while (n < 1000 && sys3(SYS_open, (i64)"/dev/ptmx", O_RDWR | 0400 /* O_NOCTTY */, 0) >= 0) n++;
  say("ptys "), number(n, 10), say("\n");
}
/* Processes, each waiting to be ended, until one is not started. */
static void forks(const char *most) {
  u64 n = 0, all = ~0ull, want = count(&most);
  for (; n < want; n++) {
    i64 pid = sys1(SYS_fork, 0);
    if (pid < 0) break;
    if (!pid) {
      sys4(SYS_rt_sigprocmask, 0 /* SIG_BLOCK */, (i64)&all, 0, 8);
      for (;;) sys4(SYS_rt_sigtimedwait, (i64)&all, 0, 0, 8);
    }
  }
  say("forks "), number(n, 10), say("\n");
}

static int main_(int argc, char **argv, char **envp) {
  /* What it was started with open, before it opens anything: a box has its three, and nothing of what ran it. */
  say("fds");
  for (i64 fd = 0; fd < 64; fd++)
    if (sys2(SYS_fcntl, fd, 1 /* F_GETFD */) >= 0) say(" "), number((u64)fd, 10);
  say("\n");
  /* (and, where what it reads from is a terminal, the size that terminal has) */
  u16 size[4];
  if (sys3(SYS_ioctl, 0, 0x5413 /* TIOCGWINSZ */, (i64)size) >= 0) say("size "), number(size[0], 10), say(" "), number(size[1], 10), say("\n");
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
  int ends = 0, waits = 0;
  for (int i = 1; i < argc; i++) {
    if (argv[i][0] == 's' && argv[i][1] == 'e' && argv[i][2] == 'e' && argv[i][3] == ':') see(argv[i] + 4);
    if (argv[i][0] == 'a' && argv[i][1] == 's' && argv[i][2] == 'k' && argv[i][3] == 's' && argv[i][4] == ':') asks(argv[i] + 5);
    if (argv[i][0] == 'o' && argv[i][1] == 'p' && argv[i][2] == 'e' && argv[i][3] == 'n' && argv[i][4] == 's' && argv[i][5] == ':') opens(argv[i] + 6);
    if (argv[i][0] == 'f' && argv[i][1] == 'o' && argv[i][2] == 'r' && argv[i][3] == 'k' && argv[i][4] == 's' && argv[i][5] == ':') forks(argv[i] + 6);
    if (same(argv[i], "ptys")) ptys();
    ends = same(argv[i], "seven") ? 7 : ends, waits |= same(argv[i], "wait");
  }
  flush();
  /* (waited for, not taken: the first process of a pid namespace is sent only what it has asked to be) */
  u64 all = ~0ull;
  if (waits) sys4(SYS_rt_sigprocmask, 0 /* SIG_BLOCK */, (i64)&all, 0, 8);
  while (waits) {
    i64 sig = sys4(SYS_rt_sigtimedwait, (i64)&all, 0, 0, 8);
    if (sig > 0) return 128 + (int)sig;
  }
  return ends;
}
