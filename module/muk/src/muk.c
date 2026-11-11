/*
 * muk: the OCI-compatible VMM. `muk run` starts a bundle's process as the OCI runtime says (its config.json: the
 * namespaces it is in, its root and what is mounted there, who it is and what it may do) and waits for it. No KVM
 * and no Firecracker under it: the host's kernel is the machine, and a box is its namespaces. One file on lib, with
 * no C library; what it does is counted in the README beside it, and checked beside runc on the same bundles
 * (test/muk.sh).
 *
 *   muk run [-b BUNDLE] [ID]      the bundle's process, started and waited for; muk ends as it ends
 *
 * config.json is read once, where it is: a string is used in its place in the text, a NUL put over its closing
 * quote, so nothing is copied. The box is made by one clone into its namespaces; in it, the root is bound on itself
 * and made the root (pivot_root), and only then is anything mounted in it: a destination is a path in the box's own
 * root, so a link the root holds leads nowhere outside it. What a bind takes from the host is opened before the
 * root changes (open_tree), where the host's paths still mean the host's.
 */
#define UNIT "muk"
#define ARENA (4 << 20)
#include "../../lib/io.h"

enum {
  SYS_rt_sigprocmask = 14, SYS_getpid = 39, SYS_execve = 59, SYS_wait4 = 61, SYS_kill = 62, SYS_chdir = 80,
  SYS_fchdir = 81, SYS_symlink = 88, SYS_umask = 95, SYS_geteuid = 107, SYS_setgroups = 116, SYS_setresuid = 117,
  SYS_setresgid = 119, SYS_capset = 126, SYS_rt_sigtimedwait = 128, SYS_mknod = 133, SYS_statfs = 137,
  SYS_pivot_root = 155, SYS_prctl = 157, SYS_mount = 165, SYS_umount2 = 166, SYS_sethostname = 170,
  SYS_setdomainname = 171, SYS_prlimit64 = 302, SYS_setns = 308, SYS_open_tree = 428, SYS_move_mount = 429,
  SYS_close_range = 436, SYS_mount_setattr = 442,
};
enum { EPERM = 1, EACCES = 13, ENOTDIR = 20 };
enum { O_DIRECTORY = 0200000, O_PATH = 010000000 };
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

static u8 *j; /* where the reader is; a NUL ends the text */
__attribute__((noreturn, cold)) static void bad(const char *why) { fail("config.json: ", why); }
static u8 peek(void) {
  while (*j == ' ' || *j == '\n' || *j == '\t' || *j == '\r') j++;
  return *j;
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
/* A string, where it is: a NUL over its closing quote; one with escapes is made shorter in its place first. */
static char *string(void) {
  take('"');
  u8 *s = j;
  /* Its end, eight bytes at a time: the first quote, backslash or control byte (a NUL ends the text, and SLACK is
   * past it to read). */
  for (;;) {
    u64 w = ld64(j), stop = zeros(w ^ '"' * ONES) | zeros(w ^ '\\' * ONES) | (~w & (w - 0x20 * ONES) & 0x80 * ONES);
    if (stop) {
      j += __builtin_ctzll(stop) >> 3;
      break;
    }
    j += 8;
  }
  if (*j == '"') {
    *j++ = 0;
    return (char *)s;
  }
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
  return (char *)s;
}
static i64 number(void) {
  int minus = peek() == '-';
  j += minus;
  if (*j < '0' || *j > '9') bad("a number is wanted");
  u64 v = 0;
  while (*j >= '0' && *j <= '9') v = v * 10 + (u64)(*j++ - '0');
  return minus ? -(i64)v : (i64)v;
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
static char *member(int *first) {
  if (peek() == '}') return j++, (char *)0;
  if (!*first) take(',');
  *first = 0;
  char *k = string();
  take(':');
  return k;
}
static int element(int *first) {
  if (peek() == ']') return j++, 0;
  if (!*first) take(',');
  *first = 0;
  return 1;
}
#define OBJECT(k) take('{'); for (int first_ = 1; ((k) = member(&first_));)
#define ARRAY take('['); for (int first_ = 1; element(&first_);)

/* ---- What it says. */

enum { WORDS = 4096, MOUNTS = 128, PATHS = 64, LINES = 32 };
struct mount { char *to, *type, *from, *data; u64 flags, clear, spread; int tree, fresh; };
struct line { u64 in, out, n; };
static struct {
  char *root, *cwd, *hostname, *domainname;
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
  u8 read_only, no_new_privs, has_caps, dev;
} c;

static void words(char **into, u32 *n, u32 most) {
  ARRAY {
    if (*n == most) bad("a list is longer than is read");
    into[(*n)++] = string();
  }
}

/* A name of a list of names NUL after NUL (ended by an empty one): which it is, or -1. */
static int which(const char *names, const char *name) {
  for (int i = 0; *names; i++) {
    if (*names == *name && same(names, name)) return i;
    names += slen(names) + 1;
  }
  return -1;
}
static const char CAPS[] =
  "CHOWN\0DAC_OVERRIDE\0DAC_READ_SEARCH\0FOWNER\0FSETID\0KILL\0SETGID\0SETUID\0SETPCAP\0LINUX_IMMUTABLE\0"
  "NET_BIND_SERVICE\0NET_BROADCAST\0NET_ADMIN\0NET_RAW\0IPC_LOCK\0IPC_OWNER\0SYS_MODULE\0SYS_RAWIO\0SYS_CHROOT\0"
  "SYS_PTRACE\0SYS_PACCT\0SYS_ADMIN\0SYS_BOOT\0SYS_NICE\0SYS_RESOURCE\0SYS_TIME\0SYS_TTY_CONFIG\0MKNOD\0LEASE\0"
  "AUDIT_WRITE\0AUDIT_CONTROL\0SETFCAP\0MAC_OVERRIDE\0MAC_ADMIN\0SYSLOG\0WAKE_ALARM\0BLOCK_SUSPEND\0AUDIT_READ\0"
  "PERFMON\0BPF\0CHECKPOINT_RESTORE\0";
static const char LIMITS[] =
  "CPU\0FSIZE\0DATA\0STACK\0CORE\0RSS\0NPROC\0NOFILE\0MEMLOCK\0AS\0LOCKS\0SIGPENDING\0MSGQUEUE\0NICE\0RTPRIO\0RTTIME\0";
static const char KINDS[] = "bounding\0effective\0permitted\0inheritable\0ambient\0";
static const char SPACES[] = "mount\0cgroup\0uts\0ipc\0user\0pid\0network\0";
static const u32 SPACE[] = {CLONE_NEWNS, CLONE_NEWCGROUP, CLONE_NEWUTS, CLONE_NEWIPC, CLONE_NEWUSER, CLONE_NEWPID, CLONE_NEWNET};

/* A name with its prefix (CAP_, RLIMIT_) taken off, among `names`. */
static int named(const char *names, const char *prefix, char *name) {
  const char *n = name;
  while (*prefix && *prefix == *n) prefix++, n++;
  int i = *prefix ? -1 : which(names, n);
  if (i < 0) fail("config.json: no such name: ", name);
  return i;
}

static void process(void) {
  char *k, *k2;
  OBJECT(k) {
    if (same(k, "args")) words(c.args, &c.nargs, WORDS - 1);
    else if (same(k, "env")) words(c.env, &c.nenv, WORDS - 1);
    else if (same(k, "cwd")) c.cwd = string();
    else if (same(k, "noNewPrivileges")) c.no_new_privs = (u8)boolean();
    else if (same(k, "terminal")) {
      if (boolean()) bad("process.terminal: a terminal is not made yet");
    } else if (same(k, "user")) {
      OBJECT(k2) {
        if (same(k2, "uid")) c.uid = (u32)number();
        else if (same(k2, "gid")) c.gid = (u32)number();
        else if (same(k2, "umask")) c.umask = number();
        else if (same(k2, "additionalGids")) {
          ARRAY {
            if (c.ngroups == PATHS) bad("a list is longer than is read");
            c.groups[c.ngroups++] = (u32)number();
          }
        } else skip();
      }
    } else if (same(k, "capabilities")) {
      c.has_caps = 1;
      OBJECT(k2) {
        int kind = which(KINDS, k2);
        if (kind < 0) { skip(); continue; }
        ARRAY c.caps[kind] |= 1ull << named(CAPS, "CAP_", string());
      }
    } else if (same(k, "rlimits")) {
      ARRAY {
        if (c.nlimits == 16) bad("a list is longer than is read");
        OBJECT(k2) {
          if (same(k2, "type")) c.limits[c.nlimits].what = (u32)named(LIMITS, "RLIMIT_", string());
          else if (same(k2, "soft")) c.limits[c.nlimits].now = (u64)number();
          else if (same(k2, "hard")) c.limits[c.nlimits].most = (u64)number();
          else skip();
        }
        c.nlimits++;
      }
    } else skip();
  }
}

/* A mount's options: those that are the kernel's flags, those that say how it spreads, and the rest, the file
 * system's own, put together again with commas between. */
static const char OPTIONS[] = /* (those a bundle has most, first) */
  "nosuid\0suid\0noexec\0exec\0nodev\0dev\0ro\0rw\0relatime\0norelatime\0strictatime\0nostrictatime\0bind\0rbind\0"
  "noatime\0atime\0nodiratime\0diratime\0sync\0async\0dirsync\0nosymfollow\0symfollow\0lazytime\0nolazytime\0defaults\0"
  "private\0rprivate\0slave\0rslave\0shared\0rshared\0unbindable\0runbindable\0";
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
    int own = 0; /* (one with a value is the file system's own: no flag has one) */
    for (char *s = o; *s; s++) own |= *s == '=';
    int i = own ? -1 : which(OPTIONS, o);
    if (i < 0) {
      if (nrest == 32) bad("a mount has more options than are read");
      rest[nrest++] = o, bytes += (u32)slen(o) + 1;
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
  ARRAY {
    if (*n == LINES) bad("a list is longer than is read");
    OBJECT(k) {
      if (same(k, "containerID")) into[*n].in = (u64)number();
      else if (same(k, "hostID")) into[*n].out = (u64)number();
      else if (same(k, "size")) into[*n].n = (u64)number();
      else skip();
    }
    (*n)++;
  }
}

static void linux_(void) {
  char *k, *k2;
  OBJECT(k) {
    if (same(k, "namespaces")) {
      ARRAY {
        int kind = -1;
        char *path = 0;
        OBJECT(k2) {
          if (same(k2, "type")) {
            char *name = string();
            if ((kind = which(SPACES, name)) < 0) fail("config.json: no such namespace is made here: ", name);
          } else if (same(k2, "path")) path = string();
          else skip();
        }
        if (kind < 0) bad("a namespace has no type");
        if (!path) c.spaces |= SPACE[kind];
        else {
          if (SPACE[kind] == CLONE_NEWNS) bad("a mount namespace is not joined yet");
          if (c.njoined == 8) bad("a list is longer than is read");
          c.joined[c.njoined].flag = SPACE[kind], c.joined[c.njoined++].path = path;
        }
      }
    } else if (same(k, "uidMappings")) lines(c.uids, &c.nuids);
    else if (same(k, "gidMappings")) lines(c.gids, &c.ngids);
    else if (same(k, "maskedPaths")) words(c.masked, &c.nmasked, PATHS);
    else if (same(k, "readonlyPaths")) words(c.readonly, &c.nreadonly, PATHS);
    else if (same(k, "seccomp")) bad("linux.seccomp: a filter is not made yet, and a box is not run without the one it asks for");
    else skip(); /* (resources: no cgroup is made yet) */
  }
}

static void config(void) {
  char *k, *k2;
  c.umask = -1, c.dev = 1;
  OBJECT(k) {
    if (same(k, "process")) process();
    else if (same(k, "root")) {
      OBJECT(k2) {
        if (same(k2, "path")) c.root = string();
        else if (same(k2, "readonly")) c.read_only = (u8)boolean();
        else skip();
      }
    } else if (same(k, "hostname")) c.hostname = string();
    else if (same(k, "domainname")) c.domainname = string();
    else if (same(k, "mounts")) {
      ARRAY {
        if (c.nmounts == MOUNTS) bad("a list is longer than is read");
        struct mount *m = &c.mounts[c.nmounts++];
        m->tree = -1;
        OBJECT(k2) {
          if (same(k2, "destination")) m->to = string();
          else if (same(k2, "type")) m->type = string();
          else if (same(k2, "source")) m->from = string();
          else if (same(k2, "options")) options(m);
          else skip();
        }
        if (!m->to || m->to[0] != '/') bad("a mount's destination is not a path from the root");
        if (m->type && same(m->type, "bind")) m->flags |= MS_BIND;
        /* Under a tmpfs mounted before it, nothing is there yet to mount it on: made first, not found missing. */
        for (struct mount *o = c.mounts; o < m; o++) {
          if (!o->type || !same(o->type, "tmpfs")) continue;
          u64 n = slen(o->to);
          m->fresh |= eq((const u8 *)m->to, (const u8 *)o->to, (u32)n) && m->to[n] == '/';
        }
        /* What is in /dev is made here, unless /dev is the host's, bound. */
        if (same(m->to, "/dev") && m->flags & MS_BIND) c.dev = 0;
      }
    } else if (same(k, "linux")) linux_();
    else if (same(k, "hooks")) bad("hooks: none is run yet");
    else skip();
  }
  if (peek()) bad("something follows it");
  if (!c.nargs) bad("process.args: nothing to run");
  if (!c.cwd || c.cwd[0] != '/') bad("process.cwd: where it runs, a path from the root");
  if (!(c.spaces & CLONE_NEWNS)) bad("linux.namespaces: a box has a mount namespace of its own");
  if ((c.spaces & CLONE_NEWUSER) && (!c.nuids || !c.ngids)) bad("a user namespace has uidMappings and gidMappings");
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
    r = sys6(SYS_move_mount, m->tree, (i64)"", AT_FDCWD, (i64)m->to, 4 /* MOVE_MOUNT_F_EMPTY_PATH */, 0);
    if (r == -ENOENT) {
      /* Nothing is there to mount it on: a directory for a directory, a file for anything else. */
      __attribute__((uninitialized)) struct kstat st;
      ok(sys4(SYS_newfstatat, m->tree, (i64)"", (i64)&st, 0x1000), "stat ", m->from);
      make_dirs(m->to, IS_DIR(st.mode));
      if (!IS_DIR(st.mode)) ok(sys3(SYS_mknod, (i64)m->to, 0100644, 0), "mknod ", m->to);
      r = sys6(SYS_move_mount, m->tree, (i64)"", AT_FDCWD, (i64)m->to, 4, 0);
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

/* What every box has in /dev: the six devices (made, or where they may not be made, the host's bound there: the old
 * root is the directory this is in), and the names a program looks for. */
static void devices(int may_make) {
  static const char nodes[] = "/dev/null\0/dev/zero\0/dev/full\0/dev/random\0/dev/urandom\0/dev/tty\0";
  static const u16 numbers[] = {1 << 8 | 3, 1 << 8 | 5, 1 << 8 | 7, 1 << 8 | 8, 1 << 8 | 9, 5 << 8 | 0};
  static const char links[] =
    "/proc/self/fd\0/dev/fd\0/proc/self/fd/0\0/dev/stdin\0/proc/self/fd/1\0/dev/stdout\0/proc/self/fd/2\0/dev/stderr\0"
    "pts/ptmx\0/dev/ptmx\0";
  const char *path = nodes;
  for (u32 i = 0; *path; i++, path += slen(path) + 1) {
    i64 r;
    for (int again = 0;; again = 1) {
      r = may_make ? sys3(SYS_mknod, (i64)path, 0020666, numbers[i]) : -EPERM;
      if (r == -EPERM) {
        r = sys3(SYS_mknod, (i64)path, 0100666, 0);
        if (r >= 0 || r == -EEXIST) r = sys6(SYS_mount, (i64)(path + 1), (i64)path, 0, MS_BIND, 0, 0);
      }
      if (r != -ENOENT || again) break;
      ok(sys2(SYS_mkdir, (i64)"/dev", 0755), "mkdir ", "/dev"); /* (a root with no /dev, and none mounted) */
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

/* The process itself, in the box: its root made and filled, then who it is and what it may do, then the program. */
__attribute__((noreturn)) static void inside(const u64 *mask, int told) {
  i64 r;
  const char *root = c.root ? c.root : "rootfs";
  sys2(SYS_prctl, 1 /* PR_SET_PDEATHSIG */, SIGKILL);
  if (told >= 0) { /* (who is who is written by the one outside: nothing is done as root in the box before it) */
    u8 b;
    if (sys3(SYS_read, told, (i64)&b, 1) != 1) leave(1);
  }
  i64 old_umask = sys1(SYS_umask, 0);

  /* The root: nothing mounted here spreads out; the root bound on itself, a mount of its own to turn on. */
  ok(sys6(SYS_mount, 0, (i64)"/", 0, MS_SLAVE | MS_REC, 0, 0), "mount: ", "/ is not made the box's own");
  ok(sys6(SYS_mount, (i64)root, (i64)root, 0, MS_BIND | MS_REC, 0, 0), "root.path: ", root);
  /* What binds take from the host, while the host's paths are the host's. */
  for (u32 i = 0; i < c.nmounts; i++) {
    struct mount *m = &c.mounts[i];
    /* A box's view of its cgroup: the one tree mounted, where the host has one tree and the box may mount it (it
     * has a cgroup namespace, or is no user namespace's); else what the host has there, bound. */
    if (m->type && same(m->type, "cgroup")) {
      u64 fs[15];
      i64 one = !sys2(SYS_statfs, (i64)"/sys/fs/cgroup", (i64)fs) && fs[0] == 0x63677270;
      if (one && (c.spaces & CLONE_NEWCGROUP || !(c.spaces & CLONE_NEWUSER))) m->type = "cgroup2", m->from = "cgroup";
      else m->from = "/sys/fs/cgroup", m->flags |= MS_BIND | MS_REC;
    }
    if (!(m->flags & MS_BIND)) continue;
    if (!m->from) bad("a bind has no source");
    m->tree = (int)ok(sys3(SYS_open_tree, AT_FDCWD, (i64)m->from, 1 /* OPEN_TREE_CLONE */ | O_CLOEXEC | (m->flags & MS_REC ? 0x8000 : 0)), "mount: its source: ", m->from);
  }
  i64 old = ok(sys3(SYS_open, (i64)"/", O_PATH | O_DIRECTORY | O_CLOEXEC, 0), "open ", "/");
  ok(sys1(SYS_chdir, (i64)root), "root.path: ", root);
  ok(sys2(SYS_pivot_root, (i64)".", (i64)"."), "pivot_root ", root);
  ok(sys1(SYS_fchdir, old), "fchdir: ", "the old root");

  for (u32 i = 0; i < c.nmounts; i++) mount_(&c.mounts[i]);
  if (c.dev) devices(!(c.spaces & CLONE_NEWUSER) && !c.njoined);
  ok(sys2(SYS_umount2, (i64)".", MNT_DETACH), "umount: ", "the old root");

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
  if (c.read_only) remount("/", MS_RDONLY);
  sys1(SYS_umask, c.umask >= 0 ? c.umask : old_umask);

  if (c.hostname) ok(sys2(SYS_sethostname, (i64)c.hostname, (i64)slen(c.hostname)), "hostname: ", c.hostname);
  if (c.domainname) ok(sys2(SYS_setdomainname, (i64)c.domainname, (i64)slen(c.domainname)), "domainname: ", c.domainname);
  for (u32 i = 0; i < c.nlimits; i++)
    ok(sys4(SYS_prlimit64, 0, c.limits[i].what, (i64)&c.limits[i].now, 0), "rlimits: ", "one is not set");

  /* Who it is and what it may do: what it may never gain first, while that may still be given up. */
  if (c.has_caps)
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
  if (c.has_caps) {
    struct { u32 version; int pid; } head = {0x20080522, 0};
    struct { u32 effective, permitted, inheritable; } sets[2];
    for (int i = 0; i < 2; i++)
      sets[i].effective = (u32)(c.caps[1] >> 32 * i), sets[i].permitted = (u32)(c.caps[2] >> 32 * i), sets[i].inheritable = (u32)(c.caps[3] >> 32 * i);
    ok(sys2(SYS_capset, (i64)&head, (i64)sets), "capabilities: ", "they are not set");
    for (i64 cap = 0; cap < 64; cap++)
      if (c.caps[4] >> cap & 1) ok(sys6(SYS_prctl, 47 /* PR_CAP_AMBIENT */, 2 /* RAISE */, cap, 0, 0, 0), "capabilities: ", "an ambient one is not raised");
  }
  if (c.no_new_privs) ok(sys6(SYS_prctl, 38 /* PR_SET_NO_NEW_PRIVS */, 1, 0, 0, 0, 0), "noNewPrivileges", "");
  sys2(SYS_prctl, 1, SIGKILL); /* (again: who it is changed, which clears it) */

  /* HOME, where the box's own /etc/passwd has the one it runs as (as runc gives it), when it is given none. */
  int home = 0;
  for (u32 i = 0; i < c.nenv; i++) home |= c.env[i][0] == 'H' && c.env[i][1] == 'O' && c.env[i][2] == 'M' && c.env[i][3] == 'E' && c.env[i][4] == '=';
  if (!home && c.nenv < WORDS - 1) {
    u8 *text = grab((64 << 10) + 8), *at = text + 5;
    __builtin_memcpy(text, "HOME=/", 7);
    i64 fd = sys3(SYS_open, (i64)"/etc/passwd", O_RDONLY | O_CLOEXEC, 0), n = fd < 0 ? 0 : sys3(SYS_read, fd, (i64)at, 64 << 10);
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
    c.env[c.nenv++] = (char *)text;
  }
  ok(sys1(SYS_chdir, (i64)c.cwd), "process.cwd: ", c.cwd);
  sys3(SYS_close_range, 3, ~0u, 4 /* CLOSE_RANGE_CLOEXEC */);
  sys4(SYS_rt_sigprocmask, 2 /* SIG_SETMASK */, (i64)mask, 0, 8);

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
    r = -ENOENT;
    while (*path) {
      const char *end = path;
      while (*end && *end != ':') end++;
      u8 *at = grab((u64)(end - path) + n + 2), *p = at;
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
  (void)envp;
  const char *bundle = 0;
  int i = 2;
  if (argc < 2 || !same(argv[1], "run")) fail("usage: ", "muk run [-b BUNDLE] [ID]");
  if (i < argc && (same(argv[i], "-b") || same(argv[i], "--bundle"))) {
    if (i + 1 == argc) fail("usage: ", "muk run [-b BUNDLE] [ID]");
    bundle = argv[i + 1], i += 2;
  }
  if (bundle) ok(sys1(SYS_chdir, (i64)bundle), "the bundle: ", bundle);

  i64 fd = ok(sys3(SYS_open, (i64)"config.json", O_RDONLY | O_CLOEXEC, 0), "open ", "config.json");
  u8 *text = grab(1 << 20);
  i64 n = ok(sys3(SYS_read, fd, (i64)text, 1 << 20), "read ", "config.json");
  if (n == 1 << 20) bad("it is longer than is read");
  sys1(SYS_close, fd);
  text[n] = 0, j = text;
  config();

  /* The namespaces it joins (the user's first: it says what one may do in the others). */
  for (int user = 1; user >= 0; user--)
    for (u32 k = 0; k < c.njoined; k++) {
      if ((c.joined[k].flag == CLONE_NEWUSER) != user) continue;
      fd = ok(sys3(SYS_open, (i64)c.joined[k].path, O_RDONLY | O_CLOEXEC, 0), "open ", c.joined[k].path);
      ok(sys2(SYS_setns, fd, c.joined[k].flag), "setns ", c.joined[k].path);
      sys1(SYS_close, fd);
    }

  /* Every signal is waited for, not taken: one sent to muk is passed on, and the box's end is one of them. */
  u64 all = ~0ull, mask = 0;
  sys4(SYS_rt_sigprocmask, 0 /* SIG_BLOCK */, (i64)&all, (i64)&mask, 8);
  int told[2] = {-1, -1};
  if (c.spaces & CLONE_NEWUSER) ok(sys2(SYS_pipe2, (i64)told, O_CLOEXEC), "pipe", "");
  i64 pid = ok(sys6(SYS_clone, (i64)(c.spaces | SIGCHLD), 0, 0, 0, 0, 0), "clone: ", "the box's namespaces are not made");
  if (!pid) inside(&mask, told[0]);
  if (c.spaces & CLONE_NEWUSER) {
    who(pid);
    sys3(SYS_write, told[1], (i64)"", 1);
  }
  for (;;) {
    struct { int signo, error, code; u8 rest[116]; } info;
    i64 sig = sys4(SYS_rt_sigtimedwait, (i64)&all, (i64)&info, 0, 8);
    if (sig == SIGCHLD) {
      int status = 0;
      if (sys4(SYS_wait4, pid, (i64)&status, 1 /* WNOHANG */, 0) == pid) return status & 0x7f ? 128 + (status & 0x7f) : status >> 8 & 0xff;
    } else if (sig > 0 && info.code <= 0) sys2(SYS_kill, pid, sig); /* (one a process sent: what the terminal sends, the box has had) */
  }
}
