/*
 * prompt: a box someone works in. `prompt run` has muk run a bundle's box with a terminal of its own, and is that
 * terminal's other end for the one at this one: what is typed here is typed there, what is shown there is shown
 * here, and the size here is its size as it changes (as it starts, the box's terminal has the size config.json
 * says: consoleSize). It ends as the box ends; told to end, it tells the box; this terminal gone, the box is ended.
 * One file on lib, with no C library.
 *
 *   prompt run [-b BUNDLE] [ID]
 *
 * It stands on muk and knows nothing of what a box is made of: it gives muk the bundle as it is given it, and has of
 * the box what muk gives (README.md): the run, which it waits for, and one descriptor, the terminal's other end,
 * sent to the socket it listens at. Nothing of a product is in it: no repo, no service, no words but its own.
 *
 * muk is the program beside this one (or $MUK).
 */
#define UNIT "prompt"
#include "../../lib/io.h"

enum {
  SYS_poll = 7, SYS_rt_sigprocmask = 14, SYS_ioctl = 16, SYS_getpid = 39, SYS_socket = 41, SYS_accept = 43, SYS_recvmsg = 47,
  SYS_bind = 49, SYS_listen = 50, SYS_execve = 59, SYS_wait4 = 61, SYS_kill = 62, SYS_rmdir = 84, SYS_readlink = 89,
  SYS_signalfd4 = 289,
};
enum { TCGETS = 0x5401, TCSETS = 0x5402, TIOCGWINSZ = 0x5413, TIOCSWINSZ = 0x5414 };
enum { SIGHUP = 1, SIGINT = 2, SIGKILL = 9, SIGTERM = 15, SIGCHLD = 17, SIGWINCH = 28 };
enum { POLLIN = 1, POLLERR = 8, POLLHUP = 16 };

/* ---- How it ends: this terminal as it was found, nothing of its own left behind. */

struct termios { u32 in, out, control, local; u8 line, keys[19]; };
static struct termios found;
static int is_terminal;
static char at[160], held[128]; /* the socket it listens at, and the directory made to hold it */
__attribute__((noreturn)) static void end(int code) {
  if (is_terminal) sys3(SYS_ioctl, 0, TCSETS, (i64)&found);
  if (at[0]) sys1(SYS_unlink, (i64)at);
  if (held[0]) sys1(SYS_rmdir, (i64)held);
  leave(code);
}
__attribute__((noreturn, cold)) static void quit(const char *what, const char *about) {
  __attribute__((uninitialized)) u8 m[400];
  u64 n = 0;
  for (const char *s = UNIT ": "; *s; s++) m[n++] = (u8)*s;
  for (const char *s = what; s && *s && n < 200; s++) m[n++] = (u8)*s;
  for (const char *s = about; s && *s && n < sizeof m - 3; s++) m[n++] = (u8)*s;
  m[n++] = '\r', m[n++] = '\n'; /* (this terminal may be raw: the line's end said whole) */
  sys3(SYS_write, 2, (i64)m, (i64)n);
  end(1);
}
static i64 ok(i64 r, const char *what, const char *about) {
  if (r < 0) quit(what, about);
  return r;
}

/* A word of this program's own, as one of a list of words given to another: where it is, found as the program
 * runs (words side by side in a list are stored as one constant otherwise, which a program with nothing to
 * relocate has not). */
static inline char *word(const char *p) {
  __asm__("" : "+r"(p));
  return (char *)p;
}
static char *copy(char *to, const char *from) {
  while (*from) *to++ = *from++;
  *to = 0;
  return to;
}
static char *decimal(char *to, u64 v) {
  char t[20];
  u32 n = 0;
  do t[n++] = (char)('0' + v % 10); while (v /= 10);
  while (n) *to++ = t[--n];
  *to = 0;
  return to;
}
static const char *said(char **envp, const char *name) {
  u64 n = slen(name);
  for (; *envp; envp++)
    if (eq((const u8 *)*envp, (const u8 *)name, (u32)n) && (*envp)[n] == '=') return *envp + n + 1;
  return 0;
}

/* All of p[0..n) written to fd, however many writes it takes. */
static void all(i64 fd, const u8 *p, i64 n) {
  while (n > 0) {
    i64 r = sys3(SYS_write, fd, (i64)p, n);
    if (r == -EINTR) continue;
    if (r <= 0) return; /* (no one there to show it to: the box goes on) */
    p += r, n -= r;
  }
}

/* The size this terminal has, given to the box's. */
static void sized(i64 its) {
  u16 size[4];
  if (sys3(SYS_ioctl, 0, TIOCGWINSZ, (i64)size) >= 0) sys3(SYS_ioctl, its, TIOCSWINSZ, (i64)size);
}

static int main_(int argc, char **argv, char **envp) {
  static const char usage[] = "prompt run [-b BUNDLE] [--lend PATH]... [--ids FIRST-LAST] [--cgroup DIR] [ID]";
  const char *bundle = ".", *id = 0;
  /* What is lent the box is muk's to hold it to: the words are handed on as they were said. */
  char *lent[40];
  u32 nlent = 0;
  int i = 2;
  if (argc < 2 || !same(argv[1], "run")) fail("usage: ", usage);
  for (; i + 1 < argc && argv[i][0] == '-'; i += 2) {
    if (same(argv[i], "-b") || same(argv[i], "--bundle")) bundle = argv[i + 1];
    else if ((same(argv[i], "--lend") || same(argv[i], "--ids") || same(argv[i], "--cgroup")) && nlent < 38) lent[nlent++] = argv[i], lent[nlent++] = argv[i + 1];
    else fail("usage: ", usage);
  }
  if (i < argc && (argv[i][0] == '-' || i + 1 < argc)) fail("usage: ", usage);
  if (i < argc) id = argv[i];

  /* muk: the one named, or the one beside this program. */
  static char muk[4200];
  const char *named = said(envp, "MUK");
  if (named) {
    if (slen(named) >= sizeof muk) fail("MUK: ", "its path is too long");
    copy(muk, named);
  } else {
    i64 n = sys3(SYS_readlink, (i64)"/proc/self/exe", (i64)muk, 4096);
    if (n <= 0) fail("muk: ", "where this program is cannot be read (/proc/self/exe); say where muk is (MUK)");
    while (n > 0 && muk[n - 1] != '/') n--;
    copy(muk + n, "muk");
  }

  /* Where the terminal's other end is sent: a socket in a directory of this run's own, no one else's to reach. */
  const char *runtime = said(envp, "XDG_RUNTIME_DIR");
  if (!runtime || !*runtime || slen(runtime) > 80) runtime = "/tmp";
  copy(decimal(copy(copy(held, runtime), "/prompt-"), (u64)sys1(SYS_getpid, 0)), "");
  copy(copy(at, held), "/console");
  sys1(SYS_unlink, (i64)at), sys1(SYS_rmdir, (i64)held); /* (what a run of this number left, long ended) */
  if (sys2(SYS_mkdir, (i64)held, 0700) < 0) held[0] = at[0] = 0, quit("no place for its socket under ", runtime);
  struct { u16 family; char path[108]; } address = {1 /* AF_UNIX */, {0}};
  if (slen(at) >= sizeof address.path) quit("its socket's path is too long: ", at);
  copy(address.path, at);
  i64 heard = ok(sys3(SYS_socket, 1, 1 /* SOCK_STREAM */ | O_CLOEXEC, 0), "socket", "");
  ok(sys3(SYS_bind, heard, (i64)&address, (i64)(2 + slen(at) + 1)), "its socket is not made: ", at);
  ok(sys2(SYS_listen, heard, 1), "listen: ", at);

  /* Its signals are read, not taken: the box's end, this terminal's size changed, and being told to end. */
  u64 mine = 1ull << (SIGCHLD - 1) | 1ull << (SIGWINCH - 1) | 1ull << (SIGTERM - 1) | 1ull << (SIGHUP - 1) | 1ull << (SIGINT - 1), before = 0;
  sys4(SYS_rt_sigprocmask, 0 /* SIG_BLOCK */, (i64)&mine, (i64)&before, 8);
  i64 signals = ok(sys4(SYS_signalfd4, -1, (i64)&mine, 8, O_CLOEXEC), "signalfd", "");

  i64 child = ok(sys1(SYS_fork, 0), "fork", "");
  if (!child) {
    /* muk: nothing of this terminal but where it says why it did not run. */
    i64 none = sys3(SYS_open, (i64)"/dev/null", O_RDWR, 0);
    if (none >= 0) sys2(SYS_dup2, none, 0), sys2(SYS_dup2, none, 1);
    sys4(SYS_rt_sigprocmask, 2 /* SIG_SETMASK */, (i64)&before, 0, 8);
    char *words[48];
    words[0] = muk, words[1] = word("run"), words[2] = word("-b"), words[3] = (char *)bundle;
    words[4] = word("--console-socket"), words[5] = at;
    for (u32 k = 0; k < nlent; k++) words[6 + k] = lent[k];
    words[6 + nlent] = (char *)id, words[7 + nlent] = 0;
    sys3(SYS_execve, (i64)muk, (i64)words, (i64)envp);
    static const char no[] = "prompt: muk is not run: ";
    sys3(SYS_write, 2, (i64)no, sizeof no - 1), sys3(SYS_write, 2, (i64)muk, (i64)slen(muk)), sys3(SYS_write, 2, (i64)"\n", 1);
    leave(127);
  }

  /* The box's terminal's other end, or muk's end without one (it said why). */
  int status = -1;
  i64 its = -1;
  struct { int fd; short want, got; } on[3] = {{(int)heard, POLLIN, 0}, {(int)signals, POLLIN, 0}, {0, POLLIN, 0}};
  __attribute__((uninitialized)) u8 told[128];
  while (its < 0) {
    sys3(SYS_poll, (i64)on, 2, -1);
    if (on[1].got) {
      sys3(SYS_read, signals, (i64)told, sizeof told);
      if (ld32(told) == SIGCHLD && sys4(SYS_wait4, child, (i64)&status, 1 /* WNOHANG */, 0) == child) end(status & 0x7f ? 128 + (status & 0x7f) : status >> 8 & 0xff);
      if (ld32(told) != SIGCHLD && ld32(told) != SIGWINCH) sys2(SYS_kill, child, ld32(told));
    }
    if (!on[0].got) continue;
    i64 from = ok(sys3(SYS_accept, heard, 0, 0), "accept", "");
    u8 name[256];
    struct { u64 len; int level, type, fd, pad; } rights = {0, 0, 0, -1, 0};
    struct { void *base; u64 len; } text = {name, sizeof name};
    struct { void *name; u32 name_len; void *text; u64 texts; void *control; u64 control_len; int flags; } message = {0, 0, &text, 1, &rights, sizeof rights, 0};
    if (sys3(SYS_recvmsg, from, (i64)&message, 0) < 0 || rights.len < 20 || rights.level != 1 || rights.type != 1 || rights.fd < 0)
      quit("muk sent no terminal", "");
    its = rights.fd;
    sys1(SYS_close, from);
  }
  sys1(SYS_close, heard), sys1(SYS_unlink, (i64)at), sys1(SYS_rmdir, (i64)held), at[0] = held[0] = 0;

  /* This terminal, for as long as the box runs: what is typed is passed on as it is typed, and nothing is shown
   * but what the box's terminal shows. */
  if (sys3(SYS_ioctl, 0, TCGETS, (i64)&found) >= 0) {
    is_terminal = 1;
    struct termios raw = found;
    raw.in &= ~(u32)(01 | 02 | 010 | 040 | 0100 | 0200 | 0400 | 02000), raw.out &= ~(u32)01;
    raw.local &= ~(u32)(01 | 02 | 010 | 0100 | 0100000), raw.control = (raw.control & ~(u32)(060 | 0400)) | 060;
    raw.keys[6] = 1, raw.keys[5] = 0;
    sys3(SYS_ioctl, 0, TCSETS, (i64)&raw);
    sized(its);
  }

  enum { ROOM = 64 << 10 };
  u8 *room = grab(ROOM);
  on[0].fd = (int)its;
  int typing = 1; /* (until what is typed here ends) */
  for (;;) {
    on[2].fd = typing ? 0 : -1;
    on[0].got = on[1].got = on[2].got = 0;
    if (sys3(SYS_poll, (i64)on, 3, -1) < 0) continue;
    if (on[1].got) {
      sys3(SYS_read, signals, (i64)told, sizeof told);
      u32 signal = ld32(told);
      if (signal == SIGWINCH) sized(its);
      else if (signal == SIGCHLD) sys4(SYS_wait4, child, (i64)&status, 1, 0);
      /* Told to end: the box is told the same, through muk. This terminal gone, there is no one at the box and
       * nothing here keeps one: muk is ended, and the box with it. */
      else sys2(SYS_kill, child, signal == SIGHUP ? SIGKILL : signal);
    }
    if (on[2].got) {
      i64 n = sys3(SYS_read, 0, (i64)room, ROOM);
      if (n > 0) all(its, room, n);
      else if (n != -EINTR) {
        typing = 0;
        if (!is_terminal) all(its, (const u8 *)"\004", 1); /* (what was typed has ended: the box's terminal is told so) */
      }
    }
    if (on[0].got) {
      i64 n = sys3(SYS_read, its, (i64)room, ROOM);
      if (n > 0) all(1, room, n);
      else if (n != -EINTR) break; /* (the box is done with its terminal) */
    }
  }
  if (status < 0) sys4(SYS_wait4, child, (i64)&status, 0, 0);
  if (is_terminal) sys3(SYS_ioctl, 0, TCSETS, (i64)&found);
  return status & 0x7f ? 128 + (status & 0x7f) : status >> 8 & 0xff;
}
