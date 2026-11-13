/* OCI config.json and the mandatory request floor. No host operations.
 * The includer supplies fail(what, about) and grab(bytes); text has sixteen zero bytes after its end.
 * IDs lent by the caller are explicit config() inputs. Native handles are applied only by muk.c.
 */
#pragma once
#include "../../lib/word.h"
#include "linux-abi.h"

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
  if (b != ' ' && b != '\t' && b != '\n' && b != '\r') bad("it is not as JSON is written");
  b = *++j; /* (one space, as after a colon: one more test) */
  if (b > ' ' || !b) return b;
  for (;;) {
    bytes16 v;
    __builtin_memcpy(&v, j, 16);
    u32 word = (u32)__builtin_ia32_pmovmskb128((chars16)((v != ' ') & (v != '\t') & (v != '\n') & (v != '\r')));
    if (word) {
      j += __builtin_ctz(word);
      if (*j && *j <= ' ') bad("it is not as JSON is written");
      return *j;
    }
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
/* Metadata is validated without turning it into a Linux NUL-terminated string. */
static void skip_string(void) {
  take('"');
  for (;;) {
    u8 c = *j++;
    if (c == '"') return;
    if (c < 32) bad("a string does not end");
    if (c != 92) continue;
    c = *j++;
    if (c == 'u') { (void)hex4(); continue; }
    if (c != '"' && c != 92 && c != '/' && c != 'b' && c != 'f' && c != 'n' && c != 'r' && c != 't')
      bad("a string escapes what is not escaped");
  }
}
/* Past one value, whatever it is. */
static void skip_value(u32 depth) {
  if (depth > 128) bad("a value is nested too deeply");
  u8 c = peek();
  if (c == '"') { skip_string(); return; }
  if (c == '{' || c == '[') {
    u8 close = c == '{' ? '}' : ']';
    j++;
    if (peek() == close) { j++; return; }
    for (;;) {
      if (c == '{') { skip_string(); take(':'); }
      skip_value(depth + 1);
      if (peek() == close) { j++; return; }
      take(',');
    }
  }
  if (c == 't' || c == 'f' || c == 'n') {
    const char *word = c == 't' ? "true" : c == 'f' ? "false" : "null";
    for (; *word; word++) if (*j++ != (u8)*word) bad("it is not as JSON is written");
    return;
  }
  if (c == '-') j++;
  if (*j == '0') j++;
  else { if (*j < '1' || *j > '9') bad("it is not as JSON is written");
    while (*j >= '0' && *j <= '9') j++; }
  if (*j == '.') { j++; if (*j < '0' || *j > '9') bad("it is not as JSON is written");
    while (*j >= '0' && *j <= '9') j++; }
  if (*j == 'e' || *j == 'E') {
    j++; if (*j == '+' || *j == '-') j++;
    if (*j < '0' || *j > '9') bad("it is not as JSON is written");
    while (*j >= '0' && *j <= '9') j++;
  }
}
static void skip(void) { skip_value(0); }
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
  if (n <= 8) return kw == w && kl == n;
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
    return k;
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
        /* OCI: each resource limit's type occurs at most once, even if its values agree. */
        for (u32 i = 0; i < c.nlimits; i++)
          if (c.limits[i].what == c.limits[c.nlimits].what) bad("process.rlimits: one kind is there twice");
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
      OBJECT(k2) {
        if (!IS("devices")) undone("linux.resources.", k2); /* (no cgroup is made yet) */
        ARRAY bad("linux.resources.devices: device rules are not enforced here");
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

static void config(u64 ids_first, u64 ids_last) {
  char *k, *k2;
  int version = 0;
  c.umask = -1, c.dev = 1;
  OBJECT(k) {
    if (IS("ociVersion")) {
      const char *v = string();
      if (v[0] != '1' || v[1] != '.' || v[2] < '0' || v[2] > '2' || v[3] != '.' || v[4] < '0' || v[4] > '9') bad("ociVersion: supported versions are 1.0.x through 1.2.x");
      const char *p = v + 4;
      if (*p == '0' && p[1]) bad("ociVersion: supported versions are 1.0.x through 1.2.x");
      while (*p >= '0' && *p <= '9') p++;
      if (*p || (u64)(p - v) != sl) bad("ociVersion: supported versions are 1.0.x through 1.2.x");
      version = 1;
    } else if (IS("annotations")) { OBJECT(k2) (void)string(); }
    else if (IS("process")) process();
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
    } else skip(); /* unknown extension fields still have to be valid JSON */
  }
  peek();
  if (j != jend) bad("something follows it");
  if (!version) bad("ociVersion: a supported version is required");
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
