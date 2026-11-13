/*
 * muk: the OCI-compatible VMM. `muk run` starts a bundle's process as the OCI runtime says (its config.json: the
 * namespaces it is in, its root and what is mounted there, who it is and what it may do) and waits for it. No KVM
 * and no Firecracker under it: the host's kernel is the machine, and a box is its namespaces. One file on lib, with
 * no C library; what it does is counted in the README beside it, and checked beside runc on the same bundles
 * (test/muk.sh).
 *
 *   muk run [-b BUNDLE] [--console-socket PATH] [--lend PATH]... [--ids FIRST-LAST] [--cgroup DIR] [ID]
 *                                 the bundle's process, started and waited for; muk ends as it ends
 *
 * Where muk ends and the Prompt begins (../../prompt). A run is a box's whole life here: muk names no box, keeps
 * none beyond its run, lists none. A terminal is a device of the box, so muk makes it where only it can (in the
 * box's own /dev/pts, config.json asking: process.terminal) and makes it the box's; its other end it gives away,
 * whole, to the one who asked (one descriptor sent over --console-socket) and keeps nothing of: what is typed and
 * shown there, its size as it changes, who is at it and whether anyone is, are the Prompt's.
 *
 * The floor: what every box has, whatever config.json says (it may ask for more, never for less): and config.json
 * is someone else's, who may mean harm, on a machine many share. So config.json asks and the one who runs muk
 * lends: nothing of the host's is a box's for its asking. A path of the host's (the root, what a bind takes, a
 * namespace joined) is the bundle's own or one lent (--lend), opened once and by the kernel's rule that nothing
 * leads out of it; its mount, pid, ipc, uts and network namespaces are its own or one lent, the first four never
 * the host's, and it has a cgroup namespace; each of the host's users it can be is one lent (--ids); it gains no
 * privilege by what it runs (no_new_privs); it has the capabilities config.json names and, in no user namespace,
 * none over the host itself; a device is what muk made in a /dev that is the box's own or one lent by its own
 * name, every other mount being nodev (the root, a bind, a tmpfs), and it makes none (CAP_MKNOD is a user
 * namespace's alone); what is mounted is what was lent or a kind that is a box's own (proc, sysfs, tmpfs, devpts,
 * mqueue, its cgroups); where it can be the host's root, what of /proc and /sys tells of the host or changes it
 * is hidden or read-only (FLOOR_PROC, FLOOR_SYS), and /sys and its cgroups are read and not written; there is
 * what no box asks the kernel at all (FILTER: the kernel itself, another process's memory, the mounts, a namespace
 * inside its own, the parts of the kernel where escapes are found, and every call the filter was not written
 * against); and what it may use of the machine is its cgroup's, the one lent (--cgroup) or muk's own, which it is
 * never out of. test/bundle/hostile.sh is a config.json written against each of these.
 *
 * config.json is read once, where it is: a string is used in its place in the text, a NUL put over its closing
 * quote, so nothing is copied. The box is made by one clone into its namespaces; in it, the root is bound on itself
 * and made the root (pivot_root), the host's root taken away, and only then is anything mounted in it: a
 * destination is a path in the box's own root with nothing of the host's above it, so a link the root holds leads
 * nowhere outside it, however far up it says to go. What a bind takes from the host is opened before the root
 * changes (openat2, then open_tree of what was opened), where the host's paths still mean the host's.
 */
#define UNIT "muk"
#define ARENA (4 << 20)
#include "../../lib/io.h"

enum {
  SYS_rt_sigprocmask = 14, SYS_ioctl = 16, SYS_getpid = 39, SYS_socket = 41, SYS_connect = 42, SYS_sendmsg = 46, SYS_fchown = 93,
  SYS_setsid = 112, SYS_execve = 59, SYS_wait4 = 61, SYS_kill = 62, SYS_chdir = 80,
  SYS_symlink = 88, SYS_umask = 95, SYS_geteuid = 107, SYS_setgroups = 116, SYS_setresuid = 117,
  SYS_setresgid = 119, SYS_capset = 126, SYS_rt_sigtimedwait = 128, SYS_mknod = 133, SYS_statfs = 137,
  SYS_pivot_root = 155, SYS_prctl = 157, SYS_mount = 165, SYS_umount2 = 166, SYS_sethostname = 170,
  SYS_setdomainname = 171, SYS_prlimit64 = 302, SYS_setns = 308, SYS_open_tree = 428, SYS_move_mount = 429,
  SYS_seccomp = 317, SYS_close_range = 436, SYS_mount_setattr = 442, SYS_fchdir = 81, SYS_fstatfs = 138,
  SYS_unshare = 272, SYS_clone3 = 435, SYS_openat2 = 437, SYS_fcntl = 72,
};
enum { EPERM = 1, EACCES = 13, ENOTDIR = 20, EAFNOSUPPORT = 97 };
enum { O_NOCTTY = 0400, O_DIRECTORY = 0200000, O_PATH = 010000000 };
enum {
  MS_RDONLY = 1, MS_NOSUID = 2, MS_NODEV = 4, MS_NOEXEC = 8, MS_SYNCHRONOUS = 16, MS_REMOUNT = 32, MS_DIRSYNC = 128,
  MS_NOSYMFOLLOW = 256, MS_NOATIME = 1024, MS_NODIRATIME = 2048, MS_BIND = 4096, MS_REC = 16384,
  MS_UNBINDABLE = 1 << 17, MS_PRIVATE = 1 << 18, MS_SLAVE = 1 << 19, MS_SHARED = 1 << 20, MS_RELATIME = 1 << 21,
  MS_STRICTATIME = 1 << 24, MS_LAZYTIME = 1 << 25,
};
#define MS_SPREAD (MS_UNBINDABLE | MS_PRIVATE | MS_SLAVE | MS_SHARED)
enum { MNT_DETACH = 2 };
enum {
  CLONE_NEWNS = 0x00020000, CLONE_NEWCGROUP = 0x02000000, CLONE_NEWUTS = 0x04000000, CLONE_NEWIPC = 0x08000000,
  CLONE_NEWUSER = 0x10000000, CLONE_NEWPID = 0x20000000, CLONE_NEWNET = 0x40000000,
};
enum { SIGKILL = 9, SIGCHLD = 17 };

/* ---- How it fails: what, about what, and the kernel's number for why. */

static u8 *dec(u8 *p, u64 v) {
  u8 t[20];
  u32 n = 0;
  do t[n++] = (u8)('0' + v % 10); while (v /= 10);
  while (n) *p++ = t[--n];
  return p;
}
__attribute__((noreturn, cold)) static void die(const char *what, const char *about, i64 r) {
  u8 m[400];
  u64 n = 0;
  for (const char *s = about; s && *s && n < sizeof m - 40; s++) m[n++] = (u8)*s;
  if (r < 0) {
    static const char e[] = " (errno ";
    for (const char *s = e; *s; s++) m[n++] = (u8)*s;
    n = (u64)(dec(m + n, (u64)-r) - m);
    m[n++] = ')';
  }
  m[n] = 0;
  fail(what, (const char *)m);
}
static i64 ok(i64 r, const char *what, const char *about) {
  if (r < 0) die(what, about, r);
  return r;
}

/* ---- config.json, read where it is. */

static u8 *j, *jend; /* where the reader is, and where the text ends (a NUL is there) */
__attribute__((noreturn, cold)) static void bad(const char *why) { fail("config.json: ", why); }
/* What it asks that is not done here: said, and the box not run without it. */
__attribute__((noreturn, cold)) static void undone(const char *in, const char *key) {
  u8 m[200];
  u64 n = 0;
  for (; *in && n < 60; in++) m[n++] = (u8)*in;
  for (; *key && n < sizeof m - 1; key++) m[n++] = (u8)*key;
  m[n] = 0;
  fail("config.json: it asks what is not done here: ", (const char *)m);
}
/* The next byte that is not between words (a space, or a byte below one; never the NUL at the text's end): where
 * there is nothing to pass over, one test; a run of it (a line's end and what the next is set in by), sixteen bytes
 * at a time. */
typedef u8 bytes16 __attribute__((vector_size(16)));
typedef char chars16 __attribute__((vector_size(16)));
static inline u8 peek(void) {
  u8 b = *j;
  if (__builtin_expect(b > ' ', 1)) return b;
  if (!b) return 0;
  b = *++j; /* (one space, as after a colon: one more test) */
  if (b > ' ' || !b) return b;
  for (;;) {
    bytes16 v;
    __builtin_memcpy(&v, j, 16);
    u32 word = (u32)__builtin_ia32_pmovmskb128((chars16)((v > ' ') | (v == 0)));
    if (word) return *(j += __builtin_ctz(word));
    j += 16;
  }
}
static void take(u8 c) {
  if (peek() != c) bad("it is not as JSON is written");
  j++;
}
static u32 hex4(void) {
  u32 v = 0;
  for (int i = 0; i < 4; i++) {
    u8 c = *j++;
    u32 d = c >= '0' && c <= '9' ? c - '0' : (c | 32) >= 'a' && (c | 32) <= 'f' ? (c | 32) - 'a' + 10 : 16;
    if (d == 16) bad("a \\u is not four hex digits");
    v = v << 4 | d;
  }
  return v;
}
/* Sixteen bytes at once (x86-64 has them): which of them is a quote, a backslash or a byte below a space. */
static inline u32 stops(const u8 *p) {
  bytes16 v;
  __builtin_memcpy(&v, p, 16);
  return (u32)__builtin_ia32_pmovmskb128((chars16)((v == '"') | (v == '\\') | (v < ' ')));
}
/* A string, where it is: a NUL over its closing quote; one with escapes is made shorter in its place first. Its
 * length is left in `sl`. */
static u32 sl;
static char *escaped(u8 *s);
__attribute__((always_inline)) static inline char *string(void) {
  take('"');
  u8 *s = j;
  /* Its end: the first quote, backslash or control byte (a NUL ends the text, and sixteen bytes past it are there
   * to read). */
  u32 stop;
  while (!(stop = stops(j))) j += 16;
  j += __builtin_ctz(stop);
  if (__builtin_expect(*j != '"', 0)) return escaped(s);
  sl = (u32)(j - s);
  *j++ = 0;
  return (char *)s;
}
/* (one with an escape in it, or that does not end: from where the first of them is) */
__attribute__((noinline, cold)) static char *escaped(u8 *s) {
  u8 *d = j;
  for (;;) {
    u32 c = *j++;
    if (c == '"') break;
    if (c < 0x20) bad("a string does not end");
    if (c == '\\') {
      c = *j++;
      if (c == 'n') c = '\n';
      else if (c == 't') c = '\t';
      else if (c == 'r') c = '\r';
      else if (c == 'b') c = '\b';
      else if (c == 'f') c = '\f';
      else if (c == 'u') {
        c = hex4();
        if (c >= 0xd800 && c < 0xdc00 && j[0] == '\\' && j[1] == 'u') {
          j += 2;
          c = 0x10000 + ((c - 0xd800) << 10) + ((hex4() - 0xdc00) & 0x3ff);
        }
        if (!c) bad("a string holds a NUL");
        if (c >= 0x10000) *d++ = (u8)(0xf0 | c >> 18), *d++ = (u8)(0x80 | (c >> 12 & 63)), *d++ = (u8)(0x80 | (c >> 6 & 63)), c = 0x80 | (c & 63);
        else if (c >= 0x800) *d++ = (u8)(0xe0 | c >> 12), *d++ = (u8)(0x80 | (c >> 6 & 63)), c = 0x80 | (c & 63);
        else if (c >= 0x80) *d++ = (u8)(0xc0 | c >> 6), c = 0x80 | (c & 63);
      } else if (c != '"' && c != '\\' && c != '/') bad("a string escapes what is not escaped");
    }
    *d++ = (u8)c;
  }
  *d = 0;
  sl = (u32)(d - s);
  return (char *)s;
}
/* A whole number from zero to `most`: none below zero, none with a fraction, none that is cut to fit. */
static u64 natural(u64 most) {
  peek();
  if (*j < '0' || *j > '9') bad("a whole number, zero or more, is wanted");
  u64 v = 0;
  do {
    u64 d = (u64)(*j++ - '0');
    if (d > most || v > (most - d) / 10) bad("a number is greater than what it sets can be");
    v = v * 10 + d;
  } while (*j >= '0' && *j <= '9');
  if (*j == '.' || (*j | 32) == 'e') bad("a whole number, zero or more, is wanted");
  return v;
}
static int boolean(void) {
  peek();
  if (j[0] == 't' && j[1] == 'r' && j[2] == 'u' && j[3] == 'e') return j += 4, 1;
  if (j[0] == 'f' && j[1] == 'a' && j[2] == 'l' && j[3] == 's' && j[4] == 'e') return j += 5, 0;
  bad("true or false is wanted");
}
/* Past one value, whatever it is. */
static void skip(void) {
  u32 depth = 0;
  do {
    u8 c = peek();
    if (c == '"') string();
    else if (c == '{' || c == '[') depth++, j++;
    else if (c == '}' || c == ']') {
      if (!depth) bad("it is not as JSON is written");
      depth--, j++;
    } else if (c == ',' || c == ':') j++;
    else if (!c) bad("it ends early");
    else while (*j > ' ' && *j != ',' && *j != '}' && *j != ']') j++;
  } while (depth);
}
/* The next member's key of the object the reader is in, or 0 at its end; the next element of an array, or 0. */
/* A member's key as it is asked about: its first eight bytes as one word (those past its end zero), its length,
 * and where it is. IS("name") is one comparison of words for a name of up to eight letters. */
static char *key;
static u64 kw;
static u32 kl;
static inline u64 head(const char *s, u64 n) { return n >= 8 ? ld64((const u8 *)s) : ld64((const u8 *)s) & ((1ull << 8 * n) - 1); }
__attribute__((always_inline)) static inline int key_is(const char *name, u64 n) {
  u64 w = 0, w2 = 0;
  __builtin_memcpy(&w, name, n < 8 ? n : 8);
  if (n <= 8) return kw == w && (n < 8 || kl == 8);
  /* (a longer name: its second word too, which is all of it for one of up to sixteen letters) */
  __builtin_memcpy(&w2, name + 8, n - 8 < 8 ? n - 8 : 8);
  return kw == w && kl == n && head(key + 8, n - 8) == w2 && (n <= 16 || same(key + 16, name + 16));
}
#define IS(name) key_is(name, sizeof(name) - 1)
static char *member(int *first) {
  for (;;) {
    if (peek() == '}') return j++, (char *)0;
    if (!*first) take(',');
    *first = 0;
    char *k = string();
    key = k, kl = sl, kw = head(k, sl);
    take(':');
    if (peek() != 'n') return k;
    /* (null: as if the member were not there) */
    if (j[1] != 'u' || j[2] != 'l' || j[3] != 'l') bad("it is not as JSON is written");
    j += 4;
  }
}
static int element(int *first) {
  if (peek() == ']') return j++, 0;
  if (!*first) take(',');
  *first = 0;
  return 1;
}
/* (each one statement, so one may stand where a statement does: under an if, or one in another) */
#define OBJECT(k) for (int first_ = (take('{'), 1); ((k) = member(&first_));)
#define ARRAY for (int first_ = (take('['), 1); element(&first_);)

/* ---- What it says. */

enum { WORDS = 4096, MOUNTS = 128, PATHS = 64, LINES = 32 };
#define ID 0xfffffffeull /* the greatest a uid or a gid is (the one past it means none) */
struct mount { char *to, *type, *from, *data; u64 flags, clear, spread; int tree, fresh; };
struct line { u64 in, out, n; };
static struct {
  char *root, *cwd, *hostname, *domainname;
  const char *console; /* --console-socket: where the one who takes the terminal's other end listens */
  char *args[WORDS], *env[WORDS];
  char *masked[PATHS], *readonly[PATHS];
  struct mount mounts[MOUNTS];
  struct { u32 flag; char *path; } joined[8];
  struct { u32 what; u64 now, most; } limits[16];
  struct line uids[LINES], gids[LINES];
  u64 caps[5]; /* bounding, effective, permitted, inheritable, ambient */
  u64 spaces;
  i64 umask;
  u32 uid, gid, groups[PATHS];
  u32 nargs, nenv, nmasked, nreadonly, nmounts, njoined, nlimits, nuids, ngids, ngroups;
  u16 rows, columns; /* its terminal's size, as it starts */
  /* user: in a user namespace, made or joined; sys: a /sys is mounted; host: it can be the host's root (it is in
   * no user namespace of its own, or its own maps one of its users onto the host's root) */
  u8 read_only, dev, user, terminal, sys, host;
} c;

/* ---- What is lent: the words of the one who runs muk. config.json asks; nothing of the host's is a box's by its
 * asking. A path of the host's (what a bind takes, the root, a namespace joined) is the bundle's own or one lent
 * (--lend); a user of the host's is one lent (--ids; to one who is not root, the kernel lends that one alone);
 * what it may use of the machine is its cgroup's (--cgroup). */
static struct { const char *path; u32 n; int fd; } lent[16]; /* n: its length, with no slash at its end */
static u32 nlent;
static u64 ids_first = 1, ids_last; /* the host's users and groups a box may be: none, until said */
static const char *cgroup;

/* A path of the host's that config.json names, opened. One not from the root is the bundle's, and leads nowhere
 * outside it, by a link or by `..` (the kernel sees to it: RESOLVE_BENEATH). One from the root is what was lent by
 * that very name (`named`: what the box's first process opened of it while it was still the one who lent it,
 * `inside`, which is not the caller's to close; or, to be read, opened again as the lender names it), or lies
 * under what was lent and leads nowhere outside that. Anything else is the host's, and no box's to name. */
static i64 taken(const char *path, u64 how, int *named) {
  struct { u64 flags, mode, resolve; } beneath = {how | O_CLOEXEC, 0, 0x08 /* RESOLVE_BENEATH */};
  *named = 0;
  if (path[0] != '/') return sys4(SYS_openat2, AT_FDCWD, (i64)path, (i64)&beneath, sizeof beneath);
  for (u32 i = 0; i < nlent; i++) {
    u32 n = lent[i].n, k = 0;
    while (k < n && path[k] == lent[i].path[k]) k++;
    if (k < n || (path[n] && path[n] != '/')) continue;
    const char *rest = path + n;
    while (*rest == '/') rest++;
    if (!*rest) return *named = 1, how == O_PATH ? lent[i].fd : sys3(SYS_open, (i64)lent[i].path, (i64)(how | O_CLOEXEC), 0);
    /* (before there is a box, for a namespace under what was lent: opened for this, and closed) */
    i64 under = lent[i].fd >= 0 ? lent[i].fd : ok(sys3(SYS_open, (i64)lent[i].path, O_PATH | O_DIRECTORY | O_CLOEXEC, 0), "--lend: ", lent[i].path);
    i64 r = sys4(SYS_openat2, under, (i64)rest, (i64)&beneath, sizeof beneath);
    if (under != lent[i].fd) sys1(SYS_close, under);
    return r;
  }
  fail("config.json: it names what is the host's and was not lent (--lend): ", path);
}

static void words(char **into, u32 *n, u32 most) {
  *n = 0; /* (a member given twice is the second, as every reader of JSON has it) */
  ARRAY {
    if (*n == most) bad("a list is longer than is read");
    into[(*n)++] = string();
  }
}

/* Which row of a table of names `name` (of `len` bytes) is, or -1. The rows are of one width, each name with
 * zeros after it: the next is a step away, and each begins with a word to compare (a name of fewer than eight
 * letters is that word and nothing else). */
static int which(const char *rows, u32 width, u32 count, const char *name, u32 len) {
  u64 h = head(name, len);
  for (u32 i = 0; i < count; i++, rows += width)
    if (ld64((const u8 *)rows) == h && (len < 8 || eq((const u8 *)rows + 8, (const u8 *)name + 8, len - 7))) return (int)i;
  return -1;
}
#define WHICH(table, name, len) which(table[0], sizeof table[0], sizeof table / sizeof table[0], name, len)
/* The same of a long table, by one look: the name's first word, multiplied, names one of 128 slots, and each name
 * of the table has a slot of its own (TABLE_MUL and TABLE_AT, a row and one: slots.ts makes them). */
static int slot(const char *rows, u32 width, const u8 *at, u64 mul, const char *name, u32 len) {
  u64 h = head(name, len);
  u32 row = at[h * mul >> 57];
  if (!row) return -1;
  rows += (row - 1) * width;
  /* (the rest of it, its NUL too: a row has zeros after its name, and the text room past the name's end) */
  return ld64((const u8 *)rows) == h && (len < 8 || eq((const u8 *)rows + 8, (const u8 *)name + 8, len - 7)) ? (int)row - 1 : -1;
}
#define SLOT(table, name, len) slot(table[0], sizeof table[0], table##_AT, table##_MUL, name, len)
static const char CAPS[][24] = {
  "CHOWN", "DAC_OVERRIDE", "DAC_READ_SEARCH", "FOWNER", "FSETID", "KILL", "SETGID", "SETUID", "SETPCAP",
  "LINUX_IMMUTABLE", "NET_BIND_SERVICE", "NET_BROADCAST", "NET_ADMIN", "NET_RAW", "IPC_LOCK", "IPC_OWNER", "SYS_MODULE",
  "SYS_RAWIO", "SYS_CHROOT", "SYS_PTRACE", "SYS_PACCT", "SYS_ADMIN", "SYS_BOOT", "SYS_NICE", "SYS_RESOURCE", "SYS_TIME",
  "SYS_TTY_CONFIG", "MKNOD", "LEASE", "AUDIT_WRITE", "AUDIT_CONTROL", "SETFCAP", "MAC_OVERRIDE", "MAC_ADMIN", "SYSLOG",
  "WAKE_ALARM", "BLOCK_SUSPEND", "AUDIT_READ", "PERFMON", "BPF", "CHECKPOINT_RESTORE"};
#define CAPS_MUL 0xc21756716e34d86bull /* (41 names; slots.ts, 6 tries) */
static const u8 CAPS_AT[128] = {0, 0, 0, 0, 0, 39, 0, 0, 0, 0, 0, 0, 0, 16, 3, 0, 0, 0, 0, 14, 1, 0, 12, 0, 0, 0, 19, 0, 0, 0, 0, 0, 0, 0, 38, 0, 0, 24, 0, 0, 0, 26, 0, 29, 0, 0, 0, 15, 0, 33, 0, 0, 35, 0, 0, 20, 41, 0, 0, 0, 0, 0, 32, 0, 7, 13, 36, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 27, 0, 5, 17, 0, 34, 0, 21, 10, 0, 0, 0, 0, 8, 0, 0, 11, 0, 0, 0, 0, 31, 23, 22, 0, 0, 0, 0, 0, 28, 4, 0, 6, 0, 0, 0, 0, 25, 0, 0, 9, 37, 30, 18, 0, 0, 0, 40, 0, 0, 0};
static const char LIMITS[][16] = {"CPU", "FSIZE", "DATA", "STACK", "CORE", "RSS", "NPROC", "NOFILE", "MEMLOCK", "AS", "LOCKS",
                                  "SIGPENDING", "MSGQUEUE", "NICE", "RTPRIO", "RTTIME"};
static const char KINDS[][16] = {"bounding", "effective", "permitted", "inheritable", "ambient"};
static const char MOUNTED[][8] = {"proc", "sysfs", "tmpfs", "devpts", "mqueue", "cgroup", "cgroup2"};
static const char SPACES[][16] = {"mount", "cgroup", "uts", "ipc", "user", "pid", "network"};
static const u32 SPACE[] = {CLONE_NEWNS, CLONE_NEWCGROUP, CLONE_NEWUTS, CLONE_NEWIPC, CLONE_NEWUSER, CLONE_NEWPID, CLONE_NEWNET};

/* The string just read with its prefix (CAP_, RLIMIT_) taken off, or 0 where it has not that prefix. */
static char *bare(const char *prefix, char *name) {
  while (*prefix && *prefix == *name) prefix++, name++, sl--;
  return *prefix ? 0 : name;
}
__attribute__((noreturn, cold)) static void no_name(const char *name) { fail("config.json: no such name: ", name); }

static void process(void) {
  char *k, *k2;
  OBJECT(k) {
    /* (each is handed to the program as a list that ends where it ends: given twice, the second ends where the
     * second ends, however long the first was) */
    if (IS("args")) words(c.args, &c.nargs, WORDS - 1), c.args[c.nargs] = 0;
    else if (IS("env")) words(c.env, &c.nenv, WORDS - 1), c.env[c.nenv] = 0;
    else if (IS("cwd")) c.cwd = string();
    else if (IS("noNewPrivileges")) boolean(); /* (the floor: it gains none, said or not) */
    else if (IS("terminal")) c.terminal = (u8)boolean();
    else if (IS("consoleSize")) {
      OBJECT(k2) {
        if (IS("height")) c.rows = (u16)natural(65535);
        else if (IS("width")) c.columns = (u16)natural(65535);
        else undone("process.consoleSize.", k2);
      }
    }
    else if (IS("user")) {
      OBJECT(k2) {
        if (IS("uid")) c.uid = (u32)natural(ID);
        else if (IS("gid")) c.gid = (u32)natural(ID);
        else if (IS("umask")) c.umask = (i64)natural(0777);
        else if (IS("additionalGids")) {
          c.ngroups = 0;
          ARRAY {
            if (c.ngroups == PATHS) bad("a list is longer than is read");
            c.groups[c.ngroups++] = (u32)natural(ID);
          }
        } else if (IS("username")) skip(); /* (another system's) */
        else undone("process.user.", k2);
      }
    } else if (IS("capabilities")) {
      for (int i = 0; i < 5; i++) c.caps[i] = 0;
      OBJECT(k2) {
        int kind = WHICH(KINDS, k2, kl);
        if (kind < 0) undone("process.capabilities.", k2);
        c.caps[kind] = 0;
        ARRAY {
          char *whole = string(), *name = bare("CAP_", whole);
          int cap = name ? SLOT(CAPS, name, sl) : -1;
          if (cap < 0) no_name(whole);
          c.caps[kind] |= 1ull << cap;
        }
      }
    } else if (IS("rlimits")) {
      c.nlimits = 0;
      ARRAY {
        if (c.nlimits == 16) bad("a list is longer than is read");
        int typed = 0;
        c.limits[c.nlimits].now = c.limits[c.nlimits].most = 0;
        OBJECT(k2) {
          if (IS("type")) {
            char *whole = string(), *name = bare("RLIMIT_", whole);
            int limit = name ? WHICH(LIMITS, name, sl) : -1;
            if (limit < 0) no_name(whole);
            c.limits[c.nlimits].what = (u32)limit, typed = 1;
          }
          else if (IS("soft")) c.limits[c.nlimits].now = natural(~0ull);
          else if (IS("hard")) c.limits[c.nlimits].most = natural(~0ull);
          else undone("process.rlimits.", k2);
        }
        if (!typed) bad("process.rlimits: a limit does not say which it is");
        c.nlimits++;
      }
    } else undone("process.", k); /* (apparmorProfile, selinuxLabel, oomScoreAdj, scheduler, ioPriority: none is set) */
  }
}

/* A mount's options: those that are the kernel's flags, those that say how it spreads, and the rest, the file
 * system's own, put together again with commas between. */
static const char OPTIONS[][16] = { /* (those a bundle has most, first) */
  "nosuid", "suid", "noexec", "exec", "nodev", "dev", "ro", "rw", "relatime", "norelatime", "strictatime", "nostrictatime",
  "bind", "rbind", "noatime", "atime", "nodiratime", "diratime", "sync", "async", "dirsync", "nosymfollow", "symfollow",
  "lazytime", "nolazytime", "defaults", "private", "rprivate", "slave", "rslave", "shared", "rshared", "unbindable",
  "runbindable"};
#define OPTIONS_MUL 0x2fa4d7b94517fed5ull /* (34 names; slots.ts, 124 tries) */
static const u8 OPTIONS_AT[128] = {0, 0, 0, 21, 0, 0, 0, 0, 0, 34, 6, 0, 0, 0, 0, 0, 0, 0, 9, 0, 5, 0, 18, 10, 0, 0, 0, 0, 0, 0, 1, 31, 0, 25, 0, 0, 0, 0, 0, 0, 0, 0, 33, 29, 0, 0, 0, 16, 0, 0, 20, 14, 0, 0, 0, 0, 3, 0, 0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 24, 0, 0, 0, 26, 19, 0, 0, 0, 7, 0, 0, 0, 27, 15, 0, 0, 22, 0, 0, 0, 0, 30, 0, 0, 11, 4, 28, 8, 0, 0, 0, 0, 0, 32, 17, 0, 0, 13, 0, 23, 0, 0, 0, 0, 0, 0, 0, 0};
/* What each sets; a zero among the first twenty-five clears what the one before it sets. */
static const u32 SETS[] = {
  MS_NOSUID, 0, MS_NOEXEC, 0, MS_NODEV, 0, MS_RDONLY, 0, MS_RELATIME, 0, MS_STRICTATIME, 0, MS_BIND, MS_BIND | MS_REC,
  MS_NOATIME, 0, MS_NODIRATIME, 0, MS_SYNCHRONOUS, 0, MS_DIRSYNC, MS_NOSYMFOLLOW, 0, MS_LAZYTIME, 0, 0,
  MS_PRIVATE, MS_PRIVATE | MS_REC, MS_SLAVE, MS_SLAVE | MS_REC, MS_SHARED, MS_SHARED | MS_REC, MS_UNBINDABLE,
  MS_UNBINDABLE | MS_REC,
};
static void options(struct mount *m) {
  char *rest[32];
  u32 nrest = 0, bytes = 1;
  ARRAY {
    char *o = string();
    int i = SLOT(OPTIONS, o, sl); /* (one that is no flag, as every one with a value is, is the file system's own) */
    if (i < 0) {
      if (nrest == 32) bad("a mount has more options than are read");
      rest[nrest++] = o, bytes += sl + 1;
    } else if (SETS[i] & MS_SPREAD) m->spread = SETS[i];
    else if (SETS[i]) m->flags |= SETS[i], m->clear &= ~(u64)SETS[i];
    else if (i < 25) m->flags &= ~(u64)SETS[i - 1], m->clear |= SETS[i - 1];
  }
  if (!nrest) return;
  u8 *d = grab(bytes);
  m->data = (char *)d;
  for (u32 i = 0; i < nrest; i++) {
    if (i) *d++ = ',';
    for (char *s = rest[i]; *s; s++) *d++ = (u8)*s;
  }
  *d = 0;
}

static void lines(struct line *into, u32 *n) {
  char *k;
  *n = 0;
  ARRAY {
    if (*n == LINES) bad("a list is longer than is read");
    into[*n].in = into[*n].out = into[*n].n = 0;
    OBJECT(k) {
      if (IS("containerID")) into[*n].in = natural(ID);
      else if (IS("hostID")) into[*n].out = natural(ID);
      else if (IS("size")) into[*n].n = natural(ID + 1);
      else undone("linux.uidMappings.", k);
    }
    (*n)++;
  }
}

static void linux_(void) {
  char *k, *k2;
  OBJECT(k) {
    if (IS("namespaces")) {
      c.spaces = 0, c.njoined = 0;
      u32 seen = 0;
      ARRAY {
        int kind = -1;
        char *path = 0;
        OBJECT(k2) {
          if (IS("type")) {
            char *name = string();
            if ((kind = WHICH(SPACES, name, sl)) < 0) fail("config.json: no such namespace is made here: ", name);
          } else if (IS("path")) path = string();
          else undone("linux.namespaces.", k2);
        }
        if (kind < 0) bad("a namespace has no type");
        if (seen & SPACE[kind]) bad("linux.namespaces: one kind is there twice");
        seen |= SPACE[kind];
        if (!path || !*path) c.spaces |= SPACE[kind];
        else {
          if (SPACE[kind] == CLONE_NEWNS) bad("a mount namespace is not joined yet");
          if (c.njoined == 8) bad("a list is longer than is read");
          c.joined[c.njoined].flag = SPACE[kind], c.joined[c.njoined++].path = path;
        }
      }
    } else if (IS("uidMappings")) lines(c.uids, &c.nuids);
    else if (IS("gidMappings")) lines(c.gids, &c.ngids);
    else if (IS("maskedPaths")) words(c.masked, &c.nmasked, PATHS);
    else if (IS("readonlyPaths")) words(c.readonly, &c.nreadonly, PATHS);
    else if (IS("resources")) {
      /* None asked for is none to set; devices all denied is what the floor is (no device but what muk made). */
      char *k3;
      OBJECT(k2) {
        if (!IS("devices")) undone("linux.resources.", k2); /* (no cgroup is made yet) */
        ARRAY OBJECT(k3) {
          if (IS("allow") && boolean()) undone("linux.resources.devices: ", "one allowed");
          else if (!IS("allow")) skip();
        }
      }
    } else undone("linux.", k); /* (seccomp, cgroupsPath, sysctl, devices, rootfsPropagation: a box is not run without what it asks for) */
  }
}

/* The floor's paths (as every runtime's defaults have them), each put in a list that does not have it. */
static const char FLOOR_PROC[][24] = { /* (hidden, the first ten; read-only, the last five) */
  "/proc/acpi", "/proc/asound", "/proc/kcore", "/proc/keys", "/proc/latency_stats", "/proc/timer_list", "/proc/timer_stats",
  "/proc/sched_debug", "/proc/scsi", "/proc/interrupts", "/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger"};
enum { FLOOR_HIDDEN = 10, FLOOR_ALL = sizeof FLOOR_PROC / sizeof FLOOR_PROC[0] };
#define FLOOR_PROC_MUL 0x9c24c18297b4231full /* (15 names; slots.ts, 1 tries) */
static const u8 FLOOR_PROC_AT[128] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 10, 14, 0, 0, 0, 0, 0, 0, 0, 11, 0, 0, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 6, 0, 0, 0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 13, 0, 0, 9, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 15, 0, 5, 0, 7, 0, 0, 0};
static const char FLOOR_SYS[][32] = {"/sys/firmware", "/sys/devices/virtual/powercap"};
/* Each of the floor's paths that neither list has, put in its own: found by one look at each path the lists have
 * (what follows /proc/ in it, as a word: slots.ts), not by each of the floor's against each of theirs. */
static void floor_(int proc) {
  u32 seen = proc ? 0 : ~0u, firmware = 0;
  for (int list = 0; list < 2; list++) {
    char **paths = list ? c.readonly : c.masked;
    for (u32 i = 0, n = list ? c.nreadonly : c.nmasked; i < n; i++) {
      const u8 *p = (const u8 *)paths[i];
      u64 first = ld64(p);
      if ((first & 0xffffffffffffull) != 0x2f636f72702full /* "/proc/" */) {
        if ((first & 0xffffffffffull) == 0x2f7379732full /* "/sys/" */)
          for (u32 k = 0; k < 2; k++) firmware |= (u32)same((const char *)p, FLOOR_SYS[k]) << k;
        continue;
      }
      u64 w = ld64(p + 6), z = zeros(w), h = z ? w & ((z & -z) - 1) : w;
      u32 row = FLOOR_PROC_AT[h * FLOOR_PROC_MUL >> 57];
      if (row && ld64((const u8 *)FLOOR_PROC[row - 1] + 6) == h && (z || same((const char *)p + 14, FLOOR_PROC[row - 1] + 14))) seen |= 1u << (row - 1);
    }
  }
  for (u32 row = 0; row < FLOOR_ALL; row++) {
    if (seen >> row & 1) continue;
    char **into = row < FLOOR_HIDDEN ? c.masked : c.readonly;
    u32 *n = row < FLOOR_HIDDEN ? &c.nmasked : &c.nreadonly;
    if (*n == PATHS) bad("a list is longer than is read");
    into[(*n)++] = (char *)FLOOR_PROC[row];
  }
  for (u32 k = 0; k < 2 && c.sys; k++) {
    if (firmware >> k & 1) continue;
    if (c.nmasked == PATHS) bad("a list is longer than is read");
    c.masked[c.nmasked++] = (char *)FLOOR_SYS[k];
  }
}

/* A devpts's own options, with the most terminals it has: PTYS, where it asks for none or for more. (The kernel
 * takes the last it is told.) */
enum { PTYS = 256 };
static char *terminals(char *data) {
  int fits = 0;
  u64 n = 0;
  for (char *o = data; o && *o; n++) {
    if (o == data || o[-1] == ',') {
      if (o[0] == 'm' && o[1] == 'a' && o[2] == 'x' && o[3] == '=') {
        u64 v = 0;
        char *d = o + 4;
        while (*d >= '0' && *d <= '9' && v <= PTYS) v = v * 10 + (u64)(*d++ - '0');
        fits = d > o + 4 && (!*d || *d == ',') && v <= PTYS;
      }
    }
    o++;
  }
  if (fits) return data;
  static const char most[] = ",max=256";
  u8 *made = grab(n + sizeof most);
  for (u64 i = 0; i < n; i++) made[i] = (u8)data[i];
  __builtin_memcpy(made + n, most + !n, sizeof most - !n);
  return (char *)made;
}
/* An address as the compiler cannot see it to be a constant: one it stores is then made where it is stored (from
 * where the program runs), each by itself. Addresses it knows, stored side by side, it may store as one constant read
 * from the program's data (GCC 14 does, whether or not the function is inlined), and a constant that holds an address
 * is something to relocate, which a program with nothing to relocate has not. */
static inline char *held(const char *s) {
  __asm__("" : "+r"(s));
  return (char *)s;
}
/* The /dev a box has where config.json mounts none: a tmpfs of its own (as config.json would say it). */
static void own_dev(struct mount *m) {
  m->to = held("/dev"), m->type = held("tmpfs");
  m->flags = MS_NOSUID | MS_STRICTATIME, m->clear = 0, m->spread = 0, m->tree = -1, m->fresh = 0;
  m->from = 0, m->data = held("mode=755,size=65536k");
}

static void config(void) {
  char *k, *k2;
  c.umask = -1, c.dev = 1;
  OBJECT(k) {
    if (IS("process")) process();
    else if (IS("root")) {
      OBJECT(k2) {
        if (IS("path")) c.root = string();
        else if (IS("readonly")) c.read_only = (u8)boolean();
        else undone("root.", k2);
      }
    } else if (IS("hostname")) c.hostname = string();
    else if (IS("domainname")) c.domainname = string();
    else if (IS("mounts")) {
      c.nmounts = 0, c.dev = 1;
      ARRAY {
        if (c.nmounts == MOUNTS) bad("a list is longer than is read");
        struct mount *m = &c.mounts[c.nmounts++];
        *m = (struct mount){.tree = -1};
        OBJECT(k2) {
          if (IS("destination")) m->to = string();
          else if (IS("type")) m->type = string();
          else if (IS("source")) m->from = string();
          else if (IS("options")) options(m);
          else undone("mounts.", k2); /* (uidMappings, gidMappings: a mount is not given other owners) */
        }
        if (!m->to || m->to[0] != '/') bad("a mount's destination is not a path from the root");
        if (m->type && same(m->type, "bind")) m->flags |= MS_BIND;
        /* What is mounted in a box: what was lent (a bind), or one of the kinds that are a box's own, each made
         * new for it. No other: not a disk, not the kernel's own tables (debugfs, tracefs, securityfs, bpf,
         * binfmt_misc), not devtmpfs with every device of the host's. And a proc at /proc, a sysfs at /sys: where
         * the floor hides what they tell of the host, which one mounted elsewhere would tell. */
        if (!(m->flags & MS_BIND)) {
          int kind = m->type ? WHICH(MOUNTED, m->type, (u32)slen(m->type)) : -1;
          if (kind < 0) fail("config.json: mounts: no such kind is mounted in a box: ", m->type ? m->type : "(none is said)");
          if (kind == 6) m->type = "cgroup";
          if ((kind == 0 && !same(m->to, "/proc")) || (kind == 1 && !same(m->to, "/sys"))) bad("mounts: a proc is mounted at /proc and a sysfs at /sys, nowhere else");
        }
        /* Under a tmpfs mounted before it, nothing is there yet to mount it on: made first, not found missing. */
        for (struct mount *o = c.mounts; o < m; o++) {
          if (!o->type || !same(o->type, "tmpfs")) continue;
          u64 n = slen(o->to);
          m->fresh |= eq((const u8 *)m->to, (const u8 *)o->to, (u32)n) && m->to[n] == '/';
        }
        /* What is in /dev is made here, unless /dev is the host's, bound. */
        if (same(m->to, "/dev") && m->flags & MS_BIND) c.dev = 0;
      }
    } else if (IS("linux")) linux_();
    else if (IS("hooks")) { /* (a kind with none in it asks for nothing) */
      OBJECT(k2) ARRAY bad("hooks: none is run yet");
    } else skip(); /* (ociVersion, annotations, and what other systems read) */
  }
  peek();
  if (j != jend) bad("something follows it");
  if (!c.nargs) bad("process.args: nothing to run");
  if (!c.cwd || c.cwd[0] != '/') bad("process.cwd: where it runs, a path from the root");
  if (!(c.spaces & CLONE_NEWNS)) bad("linux.namespaces: a box has a mount namespace of its own");
  if ((c.spaces & CLONE_NEWUSER) && (!c.nuids || !c.ngids)) bad("a user namespace has uidMappings and gidMappings");

  /* The floor. Its namespaces: each its own or another box's (so a name it is given is never the host's, and
   * what it sees and signals is never the host's processes); a cgroup namespace besides. */
  u32 own = (u32)c.spaces;
  for (u32 i = 0; i < c.njoined; i++) own |= c.joined[i].flag;
  if (~own & (CLONE_NEWPID | CLONE_NEWIPC | CLONE_NEWUTS))
    bad("linux.namespaces: a box has pid, ipc and uts namespaces of its own (or another box's): the host's are never its");
  if (!(own & CLONE_NEWNET))
    bad("linux.namespaces: a box has a network namespace of its own, or one lent it by its path (--lend): the host's is not its for saying nothing");
  if (!(own & CLONE_NEWCGROUP)) c.spaces |= CLONE_NEWCGROUP;
  c.user = (own & CLONE_NEWUSER) != 0;
  u64 caps = c.caps[0] | c.caps[1] | c.caps[2] | c.caps[3] | c.caps[4];
  /* Who it is on the host: each of the host's users and groups it can be is one lent. In a user namespace of its
   * own, those its own are mapped onto; in none, the ones it runs as, or (where it may change who it is: SETUID,
   * SETGID) every one. (One joined is another box's, lent by its path.) */
  static const char not_lent[] = "it would be one of the host's users or groups that was not lent (--ids)";
  c.host = !(c.spaces & CLONE_NEWUSER);
  if (c.spaces & CLONE_NEWUSER) {
    for (int gid = 0; gid < 2; gid++) {
      const struct line *l = gid ? c.gids : c.uids;
      for (u32 i = 0, n = gid ? c.ngids : c.nuids; i < n; i++) {
        if (!l[i].n || l[i].out < ids_first || l[i].out + l[i].n - 1 > ids_last) bad(not_lent);
        c.host |= !gid && !l[i].out;
      }
    }
  } else if (!c.user) {
    int is = caps >> 6 & 1 || caps >> 7 & 1 ? !ids_first && ids_last >= ID : c.uid >= ids_first && c.uid <= ids_last && c.gid >= ids_first && c.gid <= ids_last;
    for (u32 i = 0; i < c.ngroups; i++) is &= c.groups[i] >= ids_first && c.groups[i] <= ids_last;
    if (!is) bad(not_lent);
  }
  /* What it may do, outside a user namespace, is done to the host: it has there, at most, what is over its own
   * files and processes and (in a network namespace made for it) its own network. What is over the host itself
   * (its devices, its clock, its memory and its scheduler, its log, its modules, tracing, the administrator's
   * everything) is a box's only in a user namespace, where it is over that namespace's things alone. */
  if (!c.user) {
    u64 over = caps & ~(0xb00485ffull | (c.spaces & CLONE_NEWNET ? 0x3800 : 0));
    if (over) fail("config.json: process.capabilities: one over the host itself, a box's only in a user namespace: CAP_", CAPS[__builtin_ctzll(over)]);
  }
  /* A /dev of its own, where config.json mounts none: before everything else, since what is mounted under it
   * comes after it. */
  int has_dev = 0, has_proc = 0, has_sys = 0;
  for (u32 i = 0; i < c.nmounts; i++)
    has_dev |= same(c.mounts[i].to, "/dev"), has_proc |= same(c.mounts[i].to, "/proc"), has_sys |= same(c.mounts[i].to, "/sys");
  if (!has_dev) {
    if (c.nmounts == MOUNTS) bad("a list is longer than is read");
    for (u32 i = c.nmounts++; i; i--) {
      c.mounts[i] = c.mounts[i - 1];
      const char *to = c.mounts[i].to; /* (under the /dev now mounted before it: nothing is there to mount it on) */
      c.mounts[i].fresh |= to[0] == '/' && to[1] == 'd' && to[2] == 'e' && to[3] == 'v' && to[4] == '/';
    }
    own_dev(&c.mounts[0]);
  }
  /* What of /proc and /sys tells of the host or changes it: hidden, or read-only, to one who is root there. */
  if (c.host && (has_proc || has_sys)) c.sys = (u8)has_sys, floor_(has_proc);
  /* No file of a mount is a device, but in the /dev that is the box's own (what muk makes there) and among its
   * terminals; one that can be the host's root reads a /sys and its cgroups, and writes neither; and a box has so
   * many terminals and no more (they are the host's to run out of). */
  for (u32 i = 0; i < c.nmounts; i++) {
    struct mount *m = &c.mounts[i];
    if (m->flags & MS_BIND) continue; /* (a bind's, when what it takes is opened: inside) */
    int pts = same(m->type, "devpts"), groups = same(m->type, "cgroup");
    if (!pts && !(c.dev && same(m->to, "/dev") && same(m->type, "tmpfs"))) m->flags |= MS_NODEV;
    if (c.host && (groups || same(m->type, "sysfs"))) m->flags |= MS_RDONLY;
    if (groups) m->data = 0;
    if (pts) m->data = terminals(m->data);
  }
}

/* ---- The box. */

/* The directories on the way to `path` (and `path` itself, with `last`), made where there are none. */
static void make_dirs(char *path, int last) {
  if (last) { /* (itself first: the ones before it are mostly there) */
    i64 r = sys2(SYS_mkdir, (i64)path, 0755);
    if (r >= 0 || r == -EEXIST) return;
    if (r != -ENOENT) die("mkdir ", path, r);
  }
  for (char *s = path + 1;; s++) {
    if (*s && *s != '/') continue;
    if (!*s && !last) return;
    char end = *s;
    *s = 0;
    i64 r = sys2(SYS_mkdir, (i64)path, 0755);
    *s = end;
    if (r < 0 && r != -EEXIST) die("mkdir ", path, r);
    if (!end) return;
  }
}

static void put_text(const char *path, const u8 *text, u64 n) {
  i64 fd = ok(sys3(SYS_open, (i64)path, O_WRONLY | O_CLOEXEC, 0), "open ", path);
  ok(sys3(SYS_write, fd, (i64)text, (i64)n), "write ", path);
  sys1(SYS_close, fd);
}
/* A box's user namespace told who is who in it, by the one that made it: /proc/PID/uid_map and gid_map. */
static void who(i64 pid) {
  u8 path[40], text[LINES * 64];
  static const char proc[] = "/proc/";
  u8 *p = path;
  for (const char *s = proc; *s; s++) *p++ = (u8)*s;
  p = dec(p, (u64)pid);
  for (int gid = 0; gid < 2; gid++) {
    const struct line *l = gid ? c.gids : c.uids;
    u8 *t = text;
    for (u32 i = 0, n = gid ? c.ngids : c.nuids; i < n; i++) {
      t = dec(t, l[i].in), *t++ = ' ';
      t = dec(t, l[i].out), *t++ = ' ';
      t = dec(t, l[i].n), *t++ = '\n';
    }
    /* One who is not root may map only itself, and only once its box may not set groups. */
    if (gid && sys1(SYS_geteuid, 0)) {
      __builtin_memcpy(p, "/setgroups", 11);
      put_text((char *)path, (const u8 *)"deny", 4);
    }
    __builtin_memcpy(p, gid ? "/gid_map" : "/uid_map", 9);
    put_text((char *)path, text, (u64)(t - text));
  }
}

struct mount_attr { u64 set, clear, spread, userns; };
/* What mount(2) calls a flag, as mount_setattr(2) calls it. */
static u64 attr(u64 f) {
  return (f & (MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC)) | (f & MS_NOATIME ? 0x10 : 0) | (f & MS_STRICTATIME ? 0x20 : 0) |
         (f & MS_NODIRATIME ? 0x80 : 0) | (f & MS_NOSYMFOLLOW ? 0x200000 : 0);
}

/* One of config.json's mounts, put in the box's root (which is the root by now). */
static void mount_(struct mount *m) {
  i64 r;
  if (m->tree >= 0) {
    u64 rec = m->flags & MS_REC ? 0x8000 /* AT_RECURSIVE */ : 0;
    struct mount_attr a = {attr(m->flags), attr(m->clear) | (m->flags & (MS_NOATIME | MS_STRICTATIME) || m->clear & (MS_NOATIME | MS_STRICTATIME | MS_RELATIME) ? 0x70 : 0), m->spread & MS_SPREAD, 0};
    if (a.set | a.clear | a.spread)
      ok(sys6(SYS_mount_setattr, m->tree, (i64)"", 0x1000 /* AT_EMPTY_PATH */ | (i64)rec, (i64)&a, sizeof a, 0), "mount: its options: ", m->to);
    /* On what its destination leads to: a link there is followed, in the box's root, as mount(2) follows it. */
    enum { ONTO = 4 /* MOVE_MOUNT_F_EMPTY_PATH */ | 0x10 /* MOVE_MOUNT_T_SYMLINKS */ };
    r = sys6(SYS_move_mount, m->tree, (i64)"", AT_FDCWD, (i64)m->to, ONTO, 0);
    if (r == -ENOENT) {
      /* Nothing is there to mount it on: a directory for a directory, a file for anything else (one made by
       * another run on the same root meanwhile is as good). */
      __attribute__((uninitialized)) struct kstat st;
      ok(sys4(SYS_newfstatat, m->tree, (i64)"", (i64)&st, 0x1000), "stat ", m->from);
      make_dirs(m->to, IS_DIR(st.mode));
      if (!IS_DIR(st.mode) && (r = sys3(SYS_mknod, (i64)m->to, 0100644, 0)) < 0 && r != -EEXIST) die("mknod ", m->to, r);
      r = sys6(SYS_move_mount, m->tree, (i64)"", AT_FDCWD, (i64)m->to, ONTO, 0);
    }
    ok(r, "mount ", m->to);
    return;
  }
  const char *from = m->from ? m->from : m->type;
  if (m->fresh) make_dirs(m->to, 1);
  r = sys6(SYS_mount, (i64)from, (i64)m->to, (i64)m->type, (i64)m->flags, (i64)m->data, 0);
  if (r == -ENOENT) {
    make_dirs(m->to, 1);
    r = sys6(SYS_mount, (i64)from, (i64)m->to, (i64)m->type, (i64)m->flags, (i64)m->data, 0);
  }
  ok(r, "mount ", m->to);
  if (m->spread) ok(sys6(SYS_mount, 0, (i64)m->to, 0, (i64)m->spread, 0, 0), "mount: how it spreads: ", m->to);
}

/* What every box has in /dev: the six devices (made; or, where one in a user namespace may not make them, the
 * host's, `host`: each taken while the host's paths were the host's, and put where it goes), and the names a
 * program looks for. */
static const char NODES[] = "/dev/null\0/dev/zero\0/dev/full\0/dev/random\0/dev/urandom\0/dev/tty\0";
static void devices(const int *host) {
  static const u16 numbers[] = {1 << 8 | 3, 1 << 8 | 5, 1 << 8 | 7, 1 << 8 | 8, 1 << 8 | 9, 5 << 8 | 0};
  static const char links[] =
    "/proc/self/fd\0/dev/fd\0/proc/self/fd/0\0/dev/stdin\0/proc/self/fd/1\0/dev/stdout\0/proc/self/fd/2\0/dev/stderr\0"
    "pts/ptmx\0/dev/ptmx\0";
  const char *path = NODES;
  for (u32 i = 0; *path; i++, path += slen(path) + 1) {
    i64 r;
    for (int again = 0;; again = 1) {
      if (!host) r = sys3(SYS_mknod, (i64)path, 0020666, numbers[i]);
      else {
        r = sys3(SYS_mknod, (i64)path, 0100666, 0);
        if (r >= 0 || r == -EEXIST) r = sys6(SYS_move_mount, host[i], (i64)"", AT_FDCWD, (i64)path, 4 /* MOVE_MOUNT_F_EMPTY_PATH */, 0);
      }
      if (r != -ENOENT || again) break;
      /* (a root with no /dev, and none mounted; another run on the same root may have made it meanwhile) */
      if ((r = sys2(SYS_mkdir, (i64)"/dev", 0755)) < 0 && r != -EEXIST) die("mkdir ", "/dev", r);
    }
    if (r < 0 && r != -EEXIST) die("a device: ", path, r);
  }
  for (const char *to = links; *to;) {
    const char *name = to + slen(to) + 1;
    i64 r = sys2(SYS_symlink, (i64)to, (i64)name);
    if (r < 0 && r != -EEXIST) die("a link: ", name, r);
    to = name + slen(name) + 1;
  }
}

/* ---- The box's terminal: made in the box's own /dev/pts, its name as a program looks for it (/dev/console), the
 * box's process the one it belongs to; its other end sent, with the terminal's name, over the socket the one who
 * asked is listening at, and closed here. Nothing of it is kept: this is where muk ends. */
static i64 console = -1; /* the socket, connected while the host's paths were the host's */
static void connect_console(const char *path) {
  struct { u16 family; char path[108]; } at = {1 /* AF_UNIX */, {0}};
  u64 n = slen(path);
  if (n >= sizeof at.path) fail("--console-socket: its path is longer than a socket's may be: ", path);
  __builtin_memcpy(at.path, path, n);
  console = ok(sys3(SYS_socket, 1, 1 /* SOCK_STREAM */ | O_CLOEXEC, 0), "--console-socket: ", path);
  ok(sys3(SYS_connect, console, (i64)&at, (i64)(2 + n + 1)), "--console-socket: no one is listening at ", path);
}
static void terminal(void) {
  i64 master = ok(sys3(SYS_open, (i64)"/dev/pts/ptmx", O_RDWR | O_NOCTTY | O_CLOEXEC, 0), "process.terminal: ", "the box has no /dev/pts to make one in");
  int unlocked = 0;
  u32 number = 0;
  ok(sys3(SYS_ioctl, master, 0x40045431 /* TIOCSPTLCK */, (i64)&unlocked), "process.terminal: ", "it is not unlocked");
  ok(sys3(SYS_ioctl, master, 0x80045430 /* TIOCGPTN */, (i64)&number), "process.terminal: ", "it has no number");
  i64 it = ok(sys3(SYS_ioctl, master, 0x5441 /* TIOCGPTPEER */, O_RDWR | O_NOCTTY), "process.terminal: ", "it is not opened");
  if (c.rows | c.columns) {
    u16 size[4] = {c.rows, c.columns, 0, 0};
    sys3(SYS_ioctl, it, 0x5414 /* TIOCSWINSZ */, (i64)size);
  }
  u8 name[32] = "/dev/pts/", *end = dec(name + 9, number);
  *end = 0;
  i64 r = sys3(SYS_mknod, (i64)"/dev/console", 0100600, 0);
  if (r < 0 && r != -EEXIST) die("process.terminal: ", "/dev/console", r);
  ok(sys6(SYS_mount, (i64)name, (i64)"/dev/console", 0, MS_BIND, 0, 0), "process.terminal: ", "/dev/console");
  /* Its other end, and its name with it (as every runtime sends them): one message. */
  struct { u64 len; int level, type, fd; } rights = {20, 1 /* SOL_SOCKET */, 1 /* SCM_RIGHTS */, (int)master};
  struct { void *base; u64 len; } said = {name, (u64)(end - name)};
  struct { void *name; u32 name_len; void *said; u64 saids; void *control; u64 control_len; int flags; } message = {0, 0, &said, 1, &rights, 24, 0};
  ok(sys3(SYS_sendmsg, console, (i64)&message, 0), "--console-socket: ", "the terminal's other end is not taken");
  sys1(SYS_close, console), sys1(SYS_close, master);
  /* The box's process is its own session's first, the terminal that session's, and its three descriptors. */
  sys1(SYS_setsid, 0);
  for (i64 fd = 0; fd < 3; fd++) ok(sys2(SYS_dup2, it, fd), "process.terminal: ", "it is not the box's to read and write");
  ok(sys3(SYS_ioctl, 0, 0x540e /* TIOCSCTTY */, 0), "process.terminal: ", "it is not made the box's own");
  if (it > 2) sys1(SYS_close, it);
  if (c.uid) ok(sys3(SYS_fchown, 0, c.uid, -1), "process.terminal: ", "it is not given to the one the box runs as");
}

/* A mount there already made read-only (or with more flags), keeping what its mount may not lose (in a user
 * namespace, the flags the host's mount had). */
static void remount(const char *path, u64 flags) {
  i64 r = sys6(SYS_mount, 0, (i64)path, 0, (i64)(MS_REMOUNT | MS_BIND | flags), 0, 0);
  if (r == -EPERM) {
    u64 fs[15];
    ok(sys2(SYS_statfs, (i64)path, (i64)fs), "statfs ", path);
    u64 has = fs[10];
    flags |= (has & (MS_NOSUID | MS_NODEV | MS_NOEXEC | MS_NOATIME | MS_NODIRATIME)) | (has & 4096 ? MS_RELATIME : 0);
    r = sys6(SYS_mount, 0, (i64)path, 0, (i64)(MS_REMOUNT | MS_BIND | flags), 0, 0);
  }
  ok(r, "read-only: ", path);
}

/* ---- What no box asks the kernel: a filter over every call it makes (seccomp), there from its first instruction
 * and for every process it starts; nothing drops it, since nothing gains privilege (no_new_privs).
 *
 * Refused as the kernel refuses one who may not (EPERM): another process read or steered (ptrace,
 * process_vm_readv and writev, pidfd_getfd, process_madvise: the box's own included, so a tracer does not run in
 * one); the host's kernel itself (kexec, reboot, modules); the mounts, by the old calls and the new (the box's
 * tree is laid out once, before this); a namespace inside the box's (unshare, setns, clone with any CLONE_NEW:
 * a user namespace there is the kernel's whole surface again); bpf, perf_event_open, userfaultfd, the kernel's
 * keys, open_by_handle_at, quotas, swap, accounting, the kernel's log, vhangup, the clock set, and what only a
 * machine's owner does to x86 (iopl, ioperm, modify_ldt, uselib, _sysctl, nfsservctl); typing into a terminal or
 * pasting onto it (ioctl's TIOCSTI and TIOCLINUX: the terminal is the one who ran the box's, and its shell would
 * read it). Refused as a kernel without them does (ENOSYS), so a program takes its other way: clone3 (its flags
 * are where a filter cannot read them; clone, which is read, is what libc falls back to) and io_uring. Another
 * ABI than this machine's own (i386's and x32's calls) is ENOSYS for every call; and a socket of the kind a machine
 * talks to the one that runs it by (AF_VSOCK: it is in no namespace) is refused as a kernel without that kind does.
 *
 * And what this was not written against is not there to ask: a call numbered KNOWN or more (one a kernel newer
 * than the last read here has added) is ENOSYS, as on the kernel this was written against, until it has been read
 * and put among those refused or left to be asked. Every other call, each one read, is the box's to ask.
 *
 * The calls, in the order of their numbers: the filter is made from them as a tree, so a call that is none of
 * them is found to be none in six comparisons, not in fifty. */
enum { F_EPERM = 1, F_ENOSYS = 38, F_IOCTL = 200, F_CLONE = 201, F_SOCKET = 202 };
enum { KNOWN = 470 }; /* the first call's number that was not there to read when this was written (Linux 6.18's last is 469) */
static const struct { u16 nr; u8 how; } FILTER[] = {
  {16, F_IOCTL}, {41, F_SOCKET}, {56, F_CLONE},
  {101, F_EPERM}, /* ptrace */ {103, F_EPERM}, /* syslog */ {134, F_EPERM}, /* uselib */ {153, F_EPERM}, /* vhangup */
  {154, F_EPERM}, /* modify_ldt */ {155, F_EPERM}, /* pivot_root */ {156, F_EPERM}, /* _sysctl */
  {159, F_EPERM}, /* adjtimex */ {163, F_EPERM}, /* acct */ {164, F_EPERM}, /* settimeofday */ {165, F_EPERM}, /* mount */
  {166, F_EPERM}, /* umount2 */ {167, F_EPERM}, /* swapon */ {168, F_EPERM}, /* swapoff */ {169, F_EPERM}, /* reboot */
  {172, F_EPERM}, /* iopl */ {173, F_EPERM}, /* ioperm */ {175, F_EPERM}, /* init_module */
  {176, F_EPERM}, /* delete_module */ {179, F_EPERM}, /* quotactl */ {180, F_EPERM}, /* nfsservctl */
  {212, F_EPERM}, /* lookup_dcookie */ {227, F_EPERM}, /* clock_settime */ {246, F_EPERM}, /* kexec_load */
  {248, F_EPERM}, /* add_key */ {249, F_EPERM}, /* request_key */ {250, F_EPERM}, /* keyctl */ {272, F_EPERM}, /* unshare */
  {298, F_EPERM}, /* perf_event_open */ {304, F_EPERM}, /* open_by_handle_at */ {305, F_EPERM}, /* clock_adjtime */
  {308, F_EPERM}, /* setns */ {310, F_EPERM}, /* process_vm_readv */ {311, F_EPERM}, /* process_vm_writev */
  {313, F_EPERM}, /* finit_module */ {320, F_EPERM}, /* kexec_file_load */ {321, F_EPERM}, /* bpf */
  {323, F_EPERM}, /* userfaultfd */ {425, F_ENOSYS}, /* io_uring_setup */ {426, F_ENOSYS}, /* io_uring_enter */
  {427, F_ENOSYS}, /* io_uring_register */ {428, F_EPERM}, /* open_tree */ {429, F_EPERM}, /* move_mount */
  {430, F_EPERM}, /* fsopen */ {431, F_EPERM}, /* fsconfig */ {432, F_EPERM}, /* fsmount */ {433, F_EPERM}, /* fspick */
  {435, F_ENOSYS}, /* clone3 */ {438, F_EPERM}, /* pidfd_getfd */ {440, F_EPERM}, /* process_madvise */
  {442, F_EPERM}, /* mount_setattr */ {443, F_EPERM}, /* quotactl_fd */ {467, F_EPERM}, /* open_tree_attr */
};
enum { FILTERED = sizeof FILTER / sizeof FILTER[0] };
/* The kernel's own small machine for it (classic BPF): a word loaded of what is known of a call, compared, and an
 * answer given. */
struct bpf { u16 code; u8 jt, jf; u32 k; };
enum { LOAD = 0x20, JEQ = 0x15, JGE = 0x35, JSET = 0x45, RET = 0x06 };
enum { NR = 0, ARCH = 4, ARG0 = 16, ARG1 = 24 }; /* (where each is in what the kernel shows of a call; an argument's low half) */
#define ALLOW 0x7fff0000u
#define ERRNO(e) (0x00050000u | (e))
/* What one call's part of the filter is long, and the part itself: its number met, its answer; or, for the two
 * that are refused by what they are asked, the argument looked at. */
static u32 part(u32 i) { return FILTER[i].how == F_IOCTL ? 6 : FILTER[i].how >= F_CLONE ? 5 : 2; }
static u32 parts(u32 lo, u32 hi) {
  if (hi - lo <= 2) return (hi - lo == 2 ? part(lo) + part(lo + 1) : part(lo)) + 1;
  u32 mid = lo + (hi - lo) / 2;
  return 1 + parts(lo, mid) + parts(mid, hi);
}
static struct bpf *filter(struct bpf *p, u32 lo, u32 hi) {
  if (hi - lo > 2) { /* (the half its number is in: the lower one is next, the upper past it) */
    u32 mid = lo + (hi - lo) / 2;
    *p++ = (struct bpf){JGE, (u8)parts(lo, mid), 0, FILTER[mid].nr};
    return filter(filter(p, lo, mid), mid, hi);
  }
  for (u32 i = lo; i < hi; i++) {
    u32 nr = FILTER[i].nr, how = FILTER[i].how;
    if (how == F_IOCTL) {
      *p++ = (struct bpf){JEQ, 0, 5, nr}, *p++ = (struct bpf){LOAD, 0, 0, ARG1};
      *p++ = (struct bpf){JEQ, 1, 0, 0x5412 /* TIOCSTI */}, *p++ = (struct bpf){JEQ, 0, 1, 0x541c /* TIOCLINUX */};
      *p++ = (struct bpf){RET, 0, 0, ERRNO(EPERM)}, *p++ = (struct bpf){RET, 0, 0, ALLOW};
    } else if (how == F_CLONE) {
      *p++ = (struct bpf){JEQ, 0, 4, nr}, *p++ = (struct bpf){LOAD, 0, 0, ARG0};
      *p++ = (struct bpf){JSET, 0, 1, CLONE_NEWNS | CLONE_NEWCGROUP | CLONE_NEWUTS | CLONE_NEWIPC | CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET | 0x80 /* CLONE_NEWTIME */};
      *p++ = (struct bpf){RET, 0, 0, ERRNO(EPERM)}, *p++ = (struct bpf){RET, 0, 0, ALLOW};
    } else if (how == F_SOCKET) {
      *p++ = (struct bpf){JEQ, 0, 4, nr}, *p++ = (struct bpf){LOAD, 0, 0, ARG0};
      *p++ = (struct bpf){JEQ, 0, 1, 40 /* AF_VSOCK */};
      *p++ = (struct bpf){RET, 0, 0, ERRNO(EAFNOSUPPORT)}, *p++ = (struct bpf){RET, 0, 0, ALLOW};
    } else *p++ = (struct bpf){JEQ, 0, 1, nr}, *p++ = (struct bpf){RET, 0, 0, ERRNO(how)};
  }
  *p++ = (struct bpf){RET, 0, 0, ALLOW};
  return p;
}
/* The filter made, and from here on the box's. */
static void filtered(void) {
  struct bpf made[6 + 4 * FILTERED], *p = made;
  *p++ = (struct bpf){LOAD, 0, 0, ARCH}, *p++ = (struct bpf){JEQ, 1, 0, 0xc000003e /* AUDIT_ARCH_X86_64 */};
  *p++ = (struct bpf){RET, 0, 0, ERRNO(F_ENOSYS)};
  *p++ = (struct bpf){LOAD, 0, 0, NR}, *p++ = (struct bpf){JGE, 0, 1, KNOWN /* (x32's calls, numbered from 0x40000000, among them) */};
  *p++ = (struct bpf){RET, 0, 0, ERRNO(F_ENOSYS)};
  p = filter(p, 0, FILTERED);
  struct { u16 len; struct bpf *filter; } program = {(u16)(p - made), made};
  ok(sys3(SYS_seccomp, 1 /* SECCOMP_SET_MODE_FILTER */, 0, (i64)&program), "the filter: ", "it is not set");
}

/* The process itself, in the box: its root made and filled, then who it is and what it may do, then the program. */
__attribute__((noreturn)) static void inside(const u64 *mask, const int *told) {
  i64 r;
  const char *root = c.root ? c.root : "rootfs";
  /* It ends when the one outside does, and goes on only when that one says so: who is who is written from outside
   * first (nothing is done as root in the box before it), and one that was gone before this was asked for says
   * nothing (the pipe's other end is closed here, so its end is read). */
  sys1(SYS_close, told[1]);
  sys2(SYS_prctl, 1 /* PR_SET_PDEATHSIG */, SIGKILL);
  u8 go;
  if (sys3(SYS_read, told[0], (i64)&go, 1) != 1) leave(1);
  /* What was lent, opened by the one who lent it: this process is that one still, to the host's files, and is in
   * the box's mount namespace already (what is mounted where muk runs is not a box's to take a copy of). */
  for (u32 i = 0; i < nlent; i++) lent[i].fd = (int)ok(sys3(SYS_open, (i64)lent[i].path, O_PATH | O_CLOEXEC, 0), "--lend: ", lent[i].path);
  /* In a user namespace of its own it is that namespace's root, where it has one: who it was when made (the one
   * who runs muk) is no one there, unless that one is who its root is mapped onto. Who it is changed, which
   * clears its end with muk's: asked again, and muk seen to be there still (its end of the pipe is open). */
  if (c.spaces & CLONE_NEWUSER && sys3(SYS_setresgid, 0, 0, 0) + sys3(SYS_setresuid, 0, 0, 0) == 0) {
    sys2(SYS_prctl, 1 /* PR_SET_PDEATHSIG */, SIGKILL);
    sys3(SYS_fcntl, told[0], 4 /* F_SETFL */, O_NONBLOCK);
    if (!sys3(SYS_read, told[0], (i64)&go, 1)) leave(1);
  }
  i64 old_umask = sys1(SYS_umask, 0);
  /* (put in the cgroup lent it as it was made: its cgroup namespace begins there, so it is made here, in it) */
  if (cgroup && c.spaces & CLONE_NEWCGROUP) ok(sys1(SYS_unshare, CLONE_NEWCGROUP), "the box's cgroup namespace", "");

  /* The root: nothing mounted here spreads out; the root bound on itself, a mount of its own to turn on. */
  ok(sys6(SYS_mount, 0, (i64)"/", 0, MS_SLAVE | MS_REC, 0, 0), "mount: ", "/ is not made the box's own");
  /* The root is the directory that was opened, not what its path leads to by now: a copy of what is mounted there,
   * put on it, and turned on below. */
  int named;
  i64 at = ok(taken(root, O_PATH, &named), "root.path: ", root); /* (what is opened here is closed as the program starts) */
  i64 turned = ok(sys3(SYS_open_tree, at, (i64)"", 0x1000 /* AT_EMPTY_PATH */ | 1 /* OPEN_TREE_CLONE */ | 0x8000 /* AT_RECURSIVE */ | O_CLOEXEC), "root.path: ", root);
  ok(sys6(SYS_move_mount, turned, (i64)"", at, (i64)"", 4 /* MOVE_MOUNT_F_EMPTY_PATH */ | 0x40 /* MOVE_MOUNT_T_EMPTY_PATH */, 0), "root.path: ", root);
  /* (one in a user namespace may not make devices, and is given a /proc or a /sys on terms) */
  int user = c.user, host[6];
  /* What binds take from the host, while the host's paths are the host's. */
  for (u32 i = 0; i < c.nmounts; i++) {
    struct mount *m = &c.mounts[i];
    /* One in a user namespace is given a new /proc or /sys only where it sees one whole already (a new one then
     * shows it nothing that was covered): made here, over the host's while that is still seen, and carried into
     * the box as a bind is. */
    if (user && m->type && !(m->flags & MS_BIND) && (same(m->type, "proc") || same(m->type, "sysfs"))) {
      const char *over = m->type[0] == 'p' ? "/proc" : "/sys";
      ok(sys6(SYS_mount, (i64)(m->from ? m->from : m->type), (i64)over, (i64)m->type, (i64)m->flags, (i64)m->data, 0), "mount ", m->to);
      m->tree = (int)ok(sys3(SYS_open_tree, AT_FDCWD, (i64)over, 1 /* OPEN_TREE_CLONE */ | O_CLOEXEC), "mount ", m->to);
      m->flags = m->clear = m->spread = 0; /* (its options are on it already) */
      continue;
    }
    /* A box's view of its cgroup: the one tree mounted, where the host has one tree and the box may mount it (it
     * has a cgroup namespace, or is no user namespace's); else what the host has there, bound. */
    if (m->type && same(m->type, "cgroup")) {
      u64 fs[15];
      i64 one = !sys2(SYS_statfs, (i64)"/sys/fs/cgroup", (i64)fs) && fs[0] == 0x63677270;
      if (one && (c.spaces & CLONE_NEWCGROUP || !(c.spaces & CLONE_NEWUSER))) m->type = "cgroup2"; /* (its source is a name and no more) */
      else {
        m->flags |= MS_BIND | MS_REC;
        m->tree = (int)ok(sys3(SYS_open_tree, AT_FDCWD, (i64)"/sys/fs/cgroup", 1 /* OPEN_TREE_CLONE */ | O_CLOEXEC | 0x8000), "mount ", m->to);
      }
      continue;
    }
    if (!(m->flags & MS_BIND)) continue;
    if (!m->from) bad("a bind has no source");
    at = ok(taken(m->from, O_PATH, &named), "mount: its source: ", m->from);
    /* A device is a box's where the one who lent it named that very device: no other file of a bind is one. And
     * the host's own /proc or /sys, lent to one that can be the host's root, is read and not written. */
    __attribute__((uninitialized)) struct kstat st;
    if (named) ok(sys4(SYS_newfstatat, at, (i64)"", (i64)&st, 0x1000), "stat ", m->from);
    if (!named || ((st.mode & 0170000) != 0020000 && (st.mode & 0170000) != 0060000)) m->flags |= MS_NODEV, m->clear &= ~(u64)MS_NODEV;
    if (c.host) {
      u64 fs[15];
      ok(sys2(SYS_fstatfs, at, (i64)fs), "statfs ", m->from);
      if (fs[0] == 0x9fa0 /* proc */ || fs[0] == 0x62656572 /* sysfs */) m->flags |= MS_RDONLY, m->clear &= ~(u64)MS_RDONLY;
    }
    m->tree = (int)ok(sys3(SYS_open_tree, at, (i64)"", 0x1000 /* AT_EMPTY_PATH */ | 1 /* OPEN_TREE_CLONE */ | O_CLOEXEC | (m->flags & MS_REC ? 0x8000 : 0)), "mount: its source: ", m->from);
  }
  if (c.terminal) connect_console(c.console);
  /* (and the host's devices, for one who may not make them) */
  if (c.dev && user) {
    const char *path = NODES;
    for (u32 i = 0; *path; i++, path += slen(path) + 1)
      host[i] = (int)ok(sys3(SYS_open_tree, AT_FDCWD, (i64)path, 1 /* OPEN_TREE_CLONE */ | O_CLOEXEC), "a device: the host's: ", path);
  }
  /* The root made the root. The host's is still there, under the same name: put on the box's, where `..` at the
   * box's root would step onto it. It is taken away before any path is looked up in the box, so that a path there
   * (a mount's destination, a link the root holds, however far up it says to go) leads nowhere but the box. */
  ok(sys1(SYS_fchdir, turned), "root.path: ", root);
  ok(sys2(SYS_pivot_root, (i64)".", (i64)"."), "pivot_root ", root);
  ok(sys2(SYS_umount2, (i64)".", MNT_DETACH), "umount: ", "the host's root");

  for (u32 i = 0; i < c.nmounts; i++) mount_(&c.mounts[i]);
  if (c.dev) devices(user ? host : 0);
  if (c.terminal) terminal();
  /* Where it runs: made, as root and before the root is read-only, if nothing is there; entered now, and again as
   * the one it runs as where root itself may not (a user namespace's root, of a directory that is no one's it knows). */
  r = sys1(SYS_chdir, (i64)c.cwd);
  if (r == -ENOENT) make_dirs(c.cwd, 1), r = sys1(SYS_chdir, (i64)c.cwd);
  if (r < 0 && r != -EACCES) die("process.cwd: ", c.cwd, r);
  int later = r < 0;

  /* (what a path is hidden by is there: where the /dev is not muk's making, one that is not there is said, not
   * taken for a path with nothing to hide) */
  if (!c.dev && c.nmasked) {
    __attribute__((uninitialized)) struct kstat st;
    ok(sys4(SYS_newfstatat, AT_FDCWD, (i64)"/dev/null", (i64)&st, 0), "maskedPaths: ", "the box has no /dev/null to hide them by");
  }
  for (u32 i = 0; i < c.nmasked; i++) {
    r = sys6(SYS_mount, (i64)"/dev/null", (i64)c.masked[i], 0, MS_BIND, 0, 0);
    if (r == -ENOTDIR) r = sys6(SYS_mount, (i64)"tmpfs", (i64)c.masked[i], (i64)"tmpfs", MS_RDONLY, (i64)"size=0k", 0);
    if (r < 0 && r != -ENOENT) die("maskedPaths: ", c.masked[i], r);
  }
  for (u32 i = 0; i < c.nreadonly; i++) {
    r = sys6(SYS_mount, (i64)c.readonly[i], (i64)c.readonly[i], 0, MS_BIND | MS_REC, 0, 0);
    if (r == -ENOENT) continue;
    ok(r, "readonlyPaths: ", c.readonly[i]);
    remount(c.readonly[i], MS_RDONLY | MS_REC);
  }
  /* (the floor: no file of the root is a device, whatever the root holds) */
  remount("/", MS_NODEV | (c.read_only ? MS_RDONLY : 0));
  sys1(SYS_umask, c.umask >= 0 ? c.umask : old_umask);

  if (c.hostname) ok(sys2(SYS_sethostname, (i64)c.hostname, (i64)slen(c.hostname)), "hostname: ", c.hostname);
  if (c.domainname) ok(sys2(SYS_setdomainname, (i64)c.domainname, (i64)slen(c.domainname)), "domainname: ", c.domainname);
  /* (a limit is at most the one muk itself runs under: the lender's, which no box raises) */
  for (u32 i = 0; i < c.nlimits; i++) {
    u64 was[2];
    ok(sys4(SYS_prlimit64, 0, c.limits[i].what, (i64)&c.limits[i].now, (i64)was), "rlimits: ", "one is not set");
    if (c.limits[i].most > was[1]) fail("config.json: process.rlimits: ", "one is more than the one who runs muk has, which is the most a box has");
  }

  /* Who it is and what it may do: what it may never gain first, while that may still be given up. */
  for (i64 cap = 0; cap < 64; cap++) {
    if (c.caps[0] >> cap & 1) continue;
    r = sys2(SYS_prctl, 24 /* PR_CAPBSET_DROP */, cap);
    if (r == -EINVAL) break; /* (past the kernel's last) */
    ok(r, "capabilities: ", "the bounding set is not dropped");
  }
  if (c.uid) sys2(SYS_prctl, 8 /* PR_SET_KEEPCAPS */, 1);
  r = sys2(SYS_setgroups, c.ngroups, (i64)c.groups);
  if (r < 0 && (c.ngroups || r != -EPERM)) die("user: ", "its groups are not set", r);
  ok(sys3(SYS_setresgid, c.gid, c.gid, c.gid), "user: ", "its gid is not set");
  ok(sys3(SYS_setresuid, c.uid, c.uid, c.uid), "user: ", "its uid is not set");
  {
    struct { u32 version; int pid; } head = {0x20080522, 0};
    struct { u32 effective, permitted, inheritable; } sets[2];
    for (int i = 0; i < 2; i++)
      sets[i].effective = (u32)(c.caps[1] >> 32 * i), sets[i].permitted = (u32)(c.caps[2] >> 32 * i), sets[i].inheritable = (u32)(c.caps[3] >> 32 * i);
    ok(sys2(SYS_capset, (i64)&head, (i64)sets), "capabilities: ", "they are not set");
    for (i64 cap = 0; cap < 64; cap++)
      if (c.caps[4] >> cap & 1) ok(sys6(SYS_prctl, 47 /* PR_CAP_AMBIENT */, 2 /* RAISE */, cap, 0, 0, 0), "capabilities: ", "an ambient one is not raised");
  }
  ok(sys6(SYS_prctl, 38 /* PR_SET_NO_NEW_PRIVS */, 1, 0, 0, 0, 0), "no_new_privs", "");
  sys2(SYS_prctl, 1, SIGKILL); /* (again: who it is changed, which clears it) */

  /* HOME, where the box's own /etc/passwd has the one it runs as (as runc gives it), when it is given none. */
  int home = 0;
  for (u32 i = 0; i < c.nenv; i++) home |= c.env[i][0] == 'H' && c.env[i][1] == 'O' && c.env[i][2] == 'M' && c.env[i][3] == 'E' && c.env[i][4] == '=';
  if (!home && c.nenv < WORDS - 1) {
    /* ("HOME=/" stands by itself, before where the file is read: it is what is given unless the file has the one) */
    u8 *text = grab((64 << 10) + 16), *at = text + 8;
    __builtin_memcpy(text, "HOME=/", 7);
    /* (the box's file, and so anything: a pipe is not waited on, a terminal not taken for this one's) */
    i64 fd = sys3(SYS_open, (i64)"/etc/passwd", O_RDONLY | O_CLOEXEC | O_NONBLOCK | O_NOCTTY, 0), n = fd < 0 ? 0 : sys3(SYS_read, fd, (i64)at, 64 << 10);
    if (fd >= 0) sys1(SYS_close, fd);
    if (n > 0) at[n] = '\n';
    for (u8 *l = at, *end = at + (n > 0 ? n : 0); l < end;) { /* name:x:uid:gid:what:home:shell */
      u8 *f[7], *e = l;
      u32 nf = 0;
      for (f[nf++] = l; *e != '\n'; e++)
        if (*e == ':' && nf < 7) f[nf++] = e + 1;
      u64 uid = 0;
      u8 *d = nf > 5 ? f[2] : e;
      while (*d >= '0' && *d <= '9') uid = uid * 10 + (u64)(*d++ - '0');
      u64 len = nf > 5 ? (u64)((nf > 6 ? f[6] - 1 : e) - f[5]) : 0;
      if (len && d == f[3] - 1 && d > f[2] && uid == c.uid) {
        text = f[5] - 5;
        __builtin_memcpy(text, "HOME=", 5);
        text[5 + len] = 0;
        break;
      }
      l = e + 1;
    }
    c.env[c.nenv++] = (char *)text, c.env[c.nenv] = 0;
  }
  if (later) ok(sys1(SYS_chdir, (i64)c.cwd), "process.cwd: ", c.cwd);
  sys3(SYS_close_range, 3, ~0u, 4 /* CLOSE_RANGE_CLOEXEC */);
  sys4(SYS_rt_sigprocmask, 2 /* SIG_SETMASK */, (i64)mask, 0, 8);
  filtered(); /* (last: what is done above is what a box may not do) */

  /* The program: as it is named, or where PATH (the box's) has it. */
  char *name = c.args[0];
  int plain = 1;
  for (char *s = name; *s; s++) plain &= *s != '/';
  if (!plain) r = sys3(SYS_execve, (i64)name, (i64)c.args, (i64)c.env);
  else {
    const char *path = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
    for (u32 i = 0; i < c.nenv; i++)
      if (c.env[i][0] == 'P' && c.env[i][1] == 'A' && c.env[i][2] == 'T' && c.env[i][3] == 'H' && c.env[i][4] == '=') path = c.env[i] + 5;
    u64 n = slen(name);
    u8 *at = grab(slen(path) + n + 2); /* (the longest of PATH's places is no longer than all of it) */
    r = -ENOENT;
    while (*path) {
      const char *end = path;
      while (*end && *end != ':') end++;
      u8 *p = at;
      for (const char *s = path; s < end; s++) *p++ = (u8)*s;
      if (p > at) *p++ = '/';
      __builtin_memcpy(p, name, n + 1);
      i64 e = sys3(SYS_execve, (i64)at, (i64)c.args, (i64)c.env);
      if (e != -ENOENT && e != -ENOTDIR) r = e; /* (the one worth saying: it is there, and is not run) */
      path = *end ? end + 1 : end;
    }
  }
  die("exec ", name, r);
}

static int main_(int argc, char **argv, char **envp) {
  static const char usage[] = "muk run [-b BUNDLE] [--console-socket PATH] [--lend PATH]... [--ids FIRST-LAST] [--cgroup DIR] [ID]";
  const char *bundle = 0;
  int i = 2;
  if (argc < 2 || !same(argv[1], "run")) fail("usage: ", usage);
  /* One who is not root is lent, by the kernel, the user it is and no other: nothing is left for muk to hold it
   * to. (Who runs it is what the kernel said as it started it: what follows the environment.) */
  char **aux = envp;
  while (*aux) aux++;
  for (u64 *a = (u64 *)(aux + 1); a[0]; a += 2)
    if (a[0] == 12 /* AT_EUID */ && a[1]) ids_first = 0, ids_last = ~0ull;
  for (; i + 1 < argc && argv[i][0] == '-'; i += 2) {
    char *word = argv[i + 1];
    if (same(argv[i], "-b") || same(argv[i], "--bundle")) bundle = word;
    else if (same(argv[i], "--console-socket")) c.console = word;
    else if (same(argv[i], "--cgroup")) cgroup = word;
    else if (same(argv[i], "--lend")) {
      if (nlent == 16 || word[0] != '/') fail("--lend: a path from the root, and sixteen of them at most: ", word);
      u32 n = (u32)slen(word);
      while (n && word[n - 1] == '/') n--;
      lent[nlent].path = word, lent[nlent].n = n, lent[nlent++].fd = -1;
    } else if (same(argv[i], "--ids")) {
      u64 v[2] = {0, 0};
      char *d = word;
      for (int k = 0; k < 2; k++) {
        char *from = d;
        while (*d >= '0' && *d <= '9' && v[k] <= ID) v[k] = v[k] * 10 + (u64)(*d++ - '0');
        if (d == from || v[k] > ID || *d != (k ? 0 : '-')) fail("--ids: the first and the last of the host's users and groups lent, as FIRST-LAST: ", word);
        d++;
      }
      ids_first = v[0], ids_last = v[1];
    } else fail("usage: ", usage);
  }
  /* (what is left is the box's name, one word and no option: nothing given is passed over unread) */
  if (i < argc && (argv[i][0] == '-' || i + 1 < argc)) fail("usage: ", usage);
  if (bundle) ok(sys1(SYS_chdir, (i64)bundle), "the bundle: ", bundle);

  i64 fd = ok(sys3(SYS_open, (i64)"config.json", O_RDONLY | O_CLOEXEC, 0), "open ", "config.json");
  if (fd < 3) {
    /* It was started with standard input, output or error closed, and what it opens would take their places (the
     * box's too): they are given the place nothing is read from and nothing written to keeps, and this is opened
     * again past them. */
    sys1(SYS_close, fd);
    do fd = ok(sys3(SYS_open, (i64)"/dev/null", O_RDWR, 0), "open ", "/dev/null"); while (fd < 3);
    sys1(SYS_close, fd);
    fd = ok(sys3(SYS_open, (i64)"config.json", O_RDONLY | O_CLOEXEC, 0), "open ", "config.json");
  }
  enum { MOST = 1 << 20 };
  u8 *text = grab(MOST + 16); /* (sixteen past its end, for a string's end to be looked for there) */
  i64 n = 0, got; /* (read to its end: one read is all of a file, and not all of a pipe) */
  while ((got = ok(sys3(SYS_read, fd, (i64)(text + n), MOST - n), "read ", "config.json")) > 0) n += got;
  if (n == MOST) bad("it is longer than is read");
  sys1(SYS_close, fd);
  text[n] = 0, j = text, jend = text + n;
  config();
  /* A terminal's other end is someone's or there is no terminal: muk keeps none. */
  if (c.terminal && !c.console) bad("process.terminal: its other end goes to the one who asks for it, and no one has (--console-socket)");
  if (!c.terminal && c.console) fail("--console-socket: ", "config.json asks for no terminal (process.terminal)");

  /* The namespaces it joins (the user's first: it says what one may do in the others). What is in them already
   * can see the box's process from the moment it is made, while it is still this program and holds the host's
   * root: it is made as one that may not be traced or read through /proc, until it is the box's program. */
  if (c.njoined) sys2(SYS_prctl, 4 /* PR_SET_DUMPABLE */, 0);
  for (int user = 1; user >= 0; user--)
    for (u32 k = 0; k < c.njoined; k++) {
      if ((c.joined[k].flag == CLONE_NEWUSER) != user) continue;
      /* One that was lent, by its path; and, the network's apart, never the one muk itself is in: the host's. */
      int named;
      fd = ok(taken(c.joined[k].path, O_RDONLY, &named), "linux.namespaces: its path: ", c.joined[k].path);
      if (c.joined[k].flag != CLONE_NEWNET) {
        static const char NAMES[][8] = {"mnt", "cgroup", "uts", "ipc", "user", "pid"};
        char own[24] = "/proc/self/ns/";
        u32 kind = 0;
        while (SPACE[kind] != c.joined[k].flag) kind++;
        __builtin_memcpy(own + 14, NAMES[kind], 8);
        __attribute__((uninitialized)) struct kstat its, mine;
        ok(sys4(SYS_newfstatat, fd, (i64)"", (i64)&its, 0x1000 /* AT_EMPTY_PATH */), "stat ", c.joined[k].path);
        ok(sys4(SYS_newfstatat, AT_FDCWD, (i64)own, (i64)&mine, 0), "stat ", own);
        if (its.dev == mine.dev && its.ino == mine.ino) fail("config.json: linux.namespaces: the host's own is no box's to join: ", c.joined[k].path);
      }
      ok(sys2(SYS_setns, fd, c.joined[k].flag), "setns ", c.joined[k].path);
      sys1(SYS_close, fd);
    }

  /* Every signal is waited for, not taken: one sent to muk is passed on, and the box's end is one of them. */
  u64 all = ~0ull, mask = 0;
  sys4(SYS_rt_sigprocmask, 0 /* SIG_BLOCK */, (i64)&all, (i64)&mask, 8);
  int told[2];
  ok(sys2(SYS_pipe2, (i64)told, O_CLOEXEC), "pipe", "");
  /* Made in the cgroup lent it, where one is: what the box may use of the machine (its processes, its memory, its
   * share of the processors) is what that cgroup may, set by the one who made it, and the box is never out of
   * it. (Its cgroup namespace begins where it is when made: made by the box itself, once in.) */
  i64 pid;
  if (cgroup) {
    i64 into = ok(sys3(SYS_open, (i64)cgroup, O_RDONLY | O_DIRECTORY | O_CLOEXEC, 0), "--cgroup: ", cgroup);
    struct { u64 flags, pidfd, child_tid, parent_tid, exit_signal, stack, stack_size, tls, set_tid, set_tid_size, cgroup; } how = {
      (c.spaces & ~(u64)CLONE_NEWCGROUP) | 0x200000000ull /* CLONE_INTO_CGROUP */, 0, 0, 0, SIGCHLD, 0, 0, 0, 0, 0, (u64)into};
    pid = ok(sys2(SYS_clone3, (i64)&how, sizeof how), "--cgroup: the box is not made in it: ", cgroup);
    if (pid) sys1(SYS_close, into);
  } else pid = ok(sys6(SYS_clone, (i64)(c.spaces | SIGCHLD), 0, 0, 0, 0, 0), "clone: ", "the box's namespaces are not made");
  if (!pid) inside(&mask, told);
  if (c.spaces & CLONE_NEWUSER) who(pid);
  sys3(SYS_write, told[1], (i64)"", 1);
  for (;;) {
    struct { int signo, error, code; u8 rest[116]; } info;
    i64 sig = sys4(SYS_rt_sigtimedwait, (i64)&all, (i64)&info, 0, 8);
    if (sig == SIGCHLD) {
      int status = 0;
      if (sys4(SYS_wait4, pid, (i64)&status, 1 /* WNOHANG */, 0) == pid) return status & 0x7f ? 128 + (status & 0x7f) : status >> 8 & 0xff;
    } else if (sig > 0 && info.code <= 0) sys2(SYS_kill, pid, sig); /* (one a process sent: what the terminal sends, the box has had) */
  }
}
