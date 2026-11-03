/*
 * you: the places you have been, and back to one by a part of its name.
 *
 *   you add DIR...                         learn that you were in each DIR (a shell runs it at every cd)
 *   you query [--list] [--score] [--exclude DIR] [--] [KEYWORD...]
 *                                          the place most yours that the keywords name: each found in its path, in
 *                                          order, the last within its last part, case aside (`you query web src`
 *                                          for /root/web-42/src); --list, all of them, the most yours first
 *   you remove DIR...                      forget each DIR
 *
 * Most yours: how often you were there, by how recently (four times as much within the hour, twice within the day,
 * half within the week, a quarter after), as zoxide ranks, which this follows in what it finds and in what it keeps
 * (a place no longer there is not given; the home directory is not learnt).
 *
 * Where it keeps them: $YOU_DATA, else $XDG_DATA_HOME/you, else ~/.local/share/you. $YOU_EXCLUDE, places not to
 * learn, separated by colons (one ending in a slash and a star stands for all under it), instead of the home
 * directory.
 *
 * What it is made for: a shell runs it at every cd, so learning a place is the program's start and five calls
 * (newfstatat, open, flock, fstat, write), reading nothing, and finding one four (open, pread, newfstatat, write).
 * No C library, no allocation, nothing to relocate: the program is its own few pages, which the kernel maps and it
 * runs, and which a browser's Prompt translates in a moment (xlat), each of its calls one a Linux kernel and xlat's
 * answer alike. Its time is the vDSO's, not a call. What it works in is one arena, used from its start as far as a run
 * needs and no further, so a run touches the pages its own data reaches and no others.
 *
 * What it keeps, one file, a list of records, each a place, how much it was yours and when it last was:
 *
 *   u32 "you\1"  u16 length  u16 0  u32 rank (1/256ths)  u32 last (seconds since 1970)  u32 sum  then the place
 *
 * Learning a place appends one record (rank 1) in one write(2) to the file opened O_APPEND, which goes whole to the
 * end whoever else writes (a kernel writes one write to a file at a time). Reading adds every record of a place up.
 * Every 16 KiB appended, the writer that crosses the mark makes it again: each place once, aged (past 10000 in all,
 * each rank cut so that they make 9000, a place under 1 forgotten), a place gone for 90 days forgotten, written to a
 * file beside it, fsync'd, and renamed over it. Learners hold the file shared (flock) while they append and the one
 * remaking it holds it alone, so nothing is appended to a file being remade; one that waited on it finds what it
 * holds no longer there (fstat: no link) and opens it again. Readers take no lock: the file they read is whole, or
 * whole but for a record still being written at its end, which they leave. `sum` makes each record its own check:
 * one written in part (a disk full, a machine stopped) is passed over, and the next whole one found again.
 */

typedef unsigned long u64;
typedef long i64;
typedef unsigned int u32;
typedef unsigned short u16;
typedef unsigned char u8;

/* ---- The kernel: its calls, as x86-64 Linux numbers them. */

enum {
  SYS_read = 0, SYS_write = 1, SYS_open = 2, SYS_close = 3, SYS_fstat = 5, SYS_mmap = 9, SYS_pread = 17,
  SYS_getpid = 39, SYS_flock = 73, SYS_fsync = 74, SYS_getcwd = 79, SYS_rename = 82, SYS_mkdir = 83,
  SYS_unlink = 87, SYS_clock_gettime = 228, SYS_exit_group = 231, SYS_newfstatat = 262,
};
enum { O_RDONLY = 0, O_WRONLY = 1, O_RDWR = 2, O_CREAT = 0100, O_TRUNC = 01000, O_APPEND = 02000, O_CLOEXEC = 02000000 };
enum { LOCK_SH = 1, LOCK_EX = 2 };
enum { ENOENT = 2, EINTR = 4, EEXIST = 17 };
#define AT_FDCWD (-100)

static inline i64 sys1(i64 n, i64 a) {
  i64 r;
  __asm__ volatile("syscall" : "=a"(r) : "a"(n), "D"(a) : "rcx", "r11", "memory");
  return r;
}
static inline i64 sys2(i64 n, i64 a, i64 b) {
  i64 r;
  __asm__ volatile("syscall" : "=a"(r) : "a"(n), "D"(a), "S"(b) : "rcx", "r11", "memory");
  return r;
}
static inline i64 sys3(i64 n, i64 a, i64 b, i64 c) {
  i64 r;
  __asm__ volatile("syscall" : "=a"(r) : "a"(n), "D"(a), "S"(b), "d"(c) : "rcx", "r11", "memory");
  return r;
}
static inline i64 sys4(i64 n, i64 a, i64 b, i64 c, i64 d) {
  i64 r;
  register i64 r10 __asm__("r10") = d;
  __asm__ volatile("syscall" : "=a"(r) : "a"(n), "D"(a), "S"(b), "d"(c), "r"(r10) : "rcx", "r11", "memory");
  return r;
}
static inline i64 sys6(i64 n, i64 a, i64 b, i64 c, i64 d, i64 e, i64 f) {
  i64 r;
  register i64 r10 __asm__("r10") = d;
  register i64 r8 __asm__("r8") = e;
  register i64 r9 __asm__("r9") = f;
  __asm__ volatile("syscall" : "=a"(r) : "a"(n), "D"(a), "S"(b), "d"(c), "r"(r10), "r"(r8), "r"(r9) : "rcx", "r11", "memory");
  return r;
}

__attribute__((noreturn)) static void leave(int code) {
  for (;;) sys1(SYS_exit_group, code);
}

/* struct stat as x86-64 Linux lays it out. */
struct kstat { u64 dev, ino, nlink; u32 mode, uid, gid, pad; u64 rdev; i64 size, blksize, blocks, times[6], unused[3]; };
_Static_assert(sizeof(struct kstat) == 144, "struct stat is 144 bytes on x86-64 Linux");
#define IS_DIR(m) (((m) & 0170000) == 0040000)

/* ---- What the compiler may call (a copy or a clearing it makes of a struct or a loop): no C library has them. Eight
 * bytes at a time; built without loops turned back into calls to themselves (-fno-tree-loop-distribute-patterns). */

static inline u64 ld64(const u8 *p) { u64 v; __builtin_memcpy(&v, p, 8); return v; }
static inline u32 ld32(const u8 *p) { u32 v; __builtin_memcpy(&v, p, 4); return v; }
static inline u16 ld16(const u8 *p) { u16 v; __builtin_memcpy(&v, p, 2); return v; }
static inline void st64(u8 *p, u64 v) { __builtin_memcpy(p, &v, 8); }
static inline void st32(u8 *p, u32 v) { __builtin_memcpy(p, &v, 4); }
static inline void st16(u8 *p, u16 v) { __builtin_memcpy(p, &v, 2); }

void *memset(void *d, int c, u64 n) {
  u8 *p = d;
  u64 w = (u8)c * 0x0101010101010101ull;
  for (; n >= 8; n -= 8, p += 8) st64(p, w);
  while (n--) *p++ = (u8)c;
  return d;
}
void *memcpy(void *d, const void *s, u64 n) {
  u8 *p = d;
  const u8 *q = s;
  for (; n >= 8; n -= 8, p += 8, q += 8) st64(p, ld64(q));
  while (n--) *p++ = *q++;
  return d;
}
void *memmove(void *d, const void *s, u64 n) {
  u8 *p = d;
  const u8 *q = s;
  if (p <= q || p >= q + n) return memcpy(d, s, n);
  while (n--) p[n] = q[n];
  return d;
}
int memcmp(const void *a, const void *b, u64 n) {
  const u8 *p = a, *q = b;
  for (; n; n--, p++, q++) if (*p != *q) return *p - *q;
  return 0;
}

/* The stack protector's guard, a word of its own (-mstack-protector-guard=global: not one in thread-local storage,
 * which would take a call to set up, and which a program with no C library has none of), set from the kernel's random
 * bytes before anything it guards runs; and what a smashed stack comes to. */
__attribute__((visibility("hidden"))) u64 __stack_chk_guard;
__attribute__((noreturn, cold)) void __stack_chk_fail(void) {
  sys3(SYS_write, 2, (i64)"you: stack smashed\n", 19);
  leave(127);
}

/* ---- Small things. */

static u64 slen(const char *s) {
  const char *p = s;
  while (*p) p++;
  return (u64)(p - s);
}
static int same(const char *a, const char *b) {
  while (*a && *a == *b) a++, b++;
  return *a == *b;
}
/* Room past the end of all a run works in, for a word read there (eq, hash, lower read and write 8 bytes at a time). */
#define SLACK 8
/* Whether `a` and `b` agree in their first n bytes, eight at a time (what is read past them, within their SLACK, is
 * masked off). */
static inline int eq(const u8 *a, const u8 *b, u32 n) {
  for (; n >= 8; n -= 8, a += 8, b += 8)
    if (ld64(a) != ld64(b)) return 0;
  return !n || !((ld64(a) ^ ld64(b)) & (~0ull >> (64 - 8 * n)));
}

/* What a run works in, used from its start and as far as it needs: what it is given is SLACK past what it asks for. */
static u8 arena[1 << 21];
static u64 used;
static u8 *grab(u64 n) {
  u8 *p = arena + used;
  used += (n + SLACK + 15) & ~15ul;
  if (used > sizeof arena) {
    sys3(SYS_write, 2, (i64)"you: out of room\n", 17);
    leave(1);
  }
  return p;
}
#define LEFT (sizeof arena - used)

/* What is written to standard output, gathered and written whole (a page of it at a time). */
static u8 out[1 << 16];
static u64 outn;
static void flush(void) {
  u64 at = 0;
  while (at < outn) {
    i64 r = sys3(SYS_write, 1, (i64)(out + at), (i64)(outn - at));
    if (r == -EINTR) continue;
    if (r <= 0) leave(1);
    at += (u64)r;
  }
  outn = 0;
}
static void put(const void *s, u64 n) {
  const u8 *p = s;
  while (n) {
    u64 room = sizeof out - outn, k = n < room ? n : room;
    __builtin_memcpy(out + outn, p, k);
    outn += k, p += k, n -= k;
    if (outn == sizeof out) flush();
  }
}

__attribute__((noreturn, cold)) static void fail(const char *what, const char *about) {
  flush();
  __attribute__((uninitialized)) u8 m[600];
  u64 n = 0;
  const char *parts[3] = {"you: ", what, about};
  for (int i = 0; i < 3; i++)
    for (const char *s = parts[i]; s && *s && n < sizeof m - 2; s++) m[n++] = (u8)*s;
  m[n++] = '\n';
  sys3(SYS_write, 2, (i64)m, (i64)n);
  leave(1);
}

/* ---- The environment: the few names it reads. */

static const char *env_home, *env_xdg, *env_data, *env_exclude;

static void read_env(char **envp) {
  for (char **e = envp; *e; e++) {
    const char *s = *e;
    switch (s[0]) {
      case 'H': if (s[1] == 'O' && s[2] == 'M' && s[3] == 'E' && s[4] == '=') env_home = s + 5; break;
      case 'X': if (!memcmp(s, "XDG_DATA_HOME=", 14)) env_xdg = s + 14; break;
      case 'Y':
        if (!memcmp(s, "YOU_DATA=", 9)) env_data = s + 9;
        else if (!memcmp(s, "YOU_EXCLUDE=", 12)) env_exclude = s + 12;
        break;
    }
  }
}

/* ---- Places: made absolute and plain as a shell's $PWD is (no ., .., // or trailing /), no symlink followed. */

#define PLACE_MAX 4096

/* `in`, made plain into `o` (room for PLACE_MAX bytes and SLACK) and NUL-terminated; its length, or 0 when it cannot
 * be (too long, or the working directory unknown). */
static u32 plain(const char *in, u8 *o) {
  u64 n = 0;
  if (in[0] != '/') {
    i64 r = sys2(SYS_getcwd, (i64)o, PLACE_MAX);
    if (r <= 1) return 0;
    n = (u64)r - 1; /* without its NUL */
    if (n == 1) n = 0; /* "/" */
  }
  for (const char *s = in;;) {
    while (*s == '/') s++;
    if (!*s) break;
    const char *e = s;
    while (*e && *e != '/') e++;
    u64 k = (u64)(e - s);
    if (k == 1 && s[0] == '.') {
      /* this place */
    } else if (k == 2 && s[0] == '.' && s[1] == '.') {
      while (n && o[n - 1] != '/') n--;
      if (n) n--;
    } else {
      if (n + 1 + k >= PLACE_MAX) return 0;
      o[n++] = '/';
      __builtin_memcpy(o + n, s, k);
      n += k;
    }
    s = e;
  }
  if (!n) o[n++] = '/';
  o[n] = 0;
  return (u32)n;
}

/* Whether `p` (n bytes) is a place not to be learnt: the home directory, or what $YOU_EXCLUDE names. */
static int excluded(const u8 *p, u32 n) {
  const char *list = env_exclude;
  if (!list) {
    if (!env_home || !env_home[0]) return 0;
    u64 h = slen(env_home);
    while (h > 1 && env_home[h - 1] == '/') h--;
    return h == n && !memcmp(env_home, p, n);
  }
  for (const char *s = list; *s;) {
    const char *e = s;
    while (*e && *e != ':') e++;
    u64 k = (u64)(e - s);
    if (k >= 2 && s[k - 2] == '/' && s[k - 1] == '*') {
      if (n > k - 1 && !memcmp(s, p, k - 1)) return 1;
    } else if (k == n && !memcmp(s, p, n)) {
      return 1;
    }
    s = *e ? e + 1 : e;
  }
  return 0;
}

/* Whether `p` (NUL-terminated) is a directory now. */
static int is_dir(const u8 *p) {
  __attribute__((uninitialized)) struct kstat st;
  return sys4(SYS_newfstatat, AT_FDCWD, (i64)p, (i64)&st, 0) == 0 && IS_DIR(st.mode);
}

/* ---- Records. */

#define TAG 0x01756f79u /* "you" and 1, the form of what follows */
#define HEAD 20
#define ONE 256u /* a rank of 1 */
#define MAXAGE (10000u * ONE)
#define COMPACT_EVERY 16384
#define FORGET_GONE (90u * 86400u)

/* A place's hash, and from it a record's sum. Its bytes eight at a time in two lanes of their own (each word xored in,
 * multiplied and turned: the two lanes' multiplies go on side by side), what is read past its end masked off, the
 * lanes mixed at the end. */
static inline u64 rotl(u64 x, int r) { return x << r | x >> (64 - r); }
static inline u64 mix(u64 h) {
  h ^= h >> 32;
  h *= 0xd6e8feb86659fd93ull;
  h ^= h >> 32;
  return h;
}
static u64 hash(const u8 *p, u32 n) {
  const u64 k1 = 0x9e3779b97f4a7c15ull, k2 = 0xd6e8feb86659fd93ull;
  u64 a = n * k1, b = ~a;
  for (; n >= 16; n -= 16, p += 16) {
    a = rotl((a ^ ld64(p)) * k2, 29);
    b = rotl((b ^ ld64(p + 8)) * k1, 31);
  }
  if (n >= 8) a = rotl((a ^ ld64(p)) * k2, 29), p += 8, n -= 8;
  if (n) b = rotl((b ^ (ld64(p) & (~0ull >> (64 - 8 * n)))) * k1, 31);
  return mix(a ^ rotl(b, 17));
}
static inline u32 sum_of(u64 h, u32 n, u32 rank, u32 last) {
  return (u32)mix(h ^ ((u64)rank << 32 | last) ^ ((u64)n << 48));
}

/* A record's head at `r`, for the place that follows it there (n bytes, of hash h). */
static void head(u8 *r, u32 n, u32 rank, u32 last, u64 h) {
  st32(r, TAG);
  st32(r + 4, n); /* its length, and the u16 0 after it */
  st32(r + 8, rank);
  st32(r + 12, last);
  st32(r + 16, sum_of(h, n, rank, last));
}

/* ---- Every place the file keeps, its records added up: a table of them by their hash, as big as the file needs. */

struct place { u32 at; u32 n; u32 last; u32 gone; u64 rank; u64 hash; };
#define PLACES_MAX 16384
#define SLOTS (PLACES_MAX * 2)
static struct place places[PLACES_MAX];
static u16 slots[SLOTS]; /* 1 + a place's index; 0, none */
static u32 nplaces, mask;
static u8 *file; /* what was read of the file, and SLACK after it */

static void take(const u8 *p, u32 n, u64 h, u64 rank, u32 last) {
  u32 i = (u32)h & mask;
  for (;; i = (i + 1) & mask) {
    u16 s = slots[i];
    if (!s) break;
    struct place *e = &places[s - 1];
    if (e->hash == h && e->n == n && eq(file + e->at, p, n)) {
      e->rank += rank;
      if (last > e->last) e->last = last;
      return;
    }
  }
  if (nplaces == PLACES_MAX) return; /* more than a file it made could hold: the rest left */
  struct place *e = &places[nplaces];
  e->at = (u32)(p - file), e->n = n, e->last = last, e->gone = 0, e->rank = rank, e->hash = h;
  slots[i] = (u16)++nplaces;
}

/* The place `p` (n bytes, SLACK after it) in the table, or none. */
static struct place *find(const u8 *p, u32 n) {
  u64 h = hash(p, n);
  for (u32 i = (u32)h & mask;; i = (i + 1) & mask) {
    u16 s = slots[i];
    if (!s) return 0;
    struct place *e = &places[s - 1];
    if (e->hash == h && e->n == n && eq(file + e->at, p, n)) return e;
  }
}

/* Read the whole file `fd` holds (from its start, whoever appends meanwhile) and add up its records: of the places
 * `wanted` says (a query's: what its keywords name), or all. What fits in what is left of the arena is read in one
 * call, its size unasked (a file read short is read to its end); a file bigger, into room made for it. */
static int (*wanted)(const u8 *p, u32 n);
static void load(int fd) {
  file = arena + used;
  u64 cap = LEFT - SLACK, got = 0;
  for (;;) {
    i64 r = sys4(SYS_pread, fd, (i64)(file + got), (i64)(cap - got), (i64)got);
    if (r == -EINTR) continue;
    if (r <= 0) break; /* its end (or shorter than it was: what was read is what there is) */
    got += (u64)r;
    if (got < cap) break;
    __attribute__((uninitialized)) struct kstat st;
    if (sys2(SYS_fstat, fd, (i64)&st) || (u64)st.size <= got) break;
    cap = (u64)st.size + (1 << 16);
    i64 m = sys6(SYS_mmap, 0, (i64)((cap + SLACK + 4095) & ~4095ul), 3, 0x22, -1, 0); /* RW, private anonymous */
    if (m < 0 && m > -4096) fail("no room to read where it keeps places", 0);
    __builtin_memcpy((u8 *)m, file, got);
    file = (u8 *)m;
  }
  if (file == arena + used) grab(got);
  /* As many slots as twice the records it could hold: past what one run reads, none touched. */
  u64 most = got / (HEAD + 1) + 1;
  u32 slots_n = 64;
  while (slots_n < 2 * most && slots_n < SLOTS) slots_n <<= 1;
  mask = slots_n - 1;
  const u8 *p = file, *end = file + got;
  while (end - p >= HEAD) {
    u32 n;
    if (ld32(p) != TAG || (n = ld16(p + 4)) == 0 || n >= PLACE_MAX || ld16(p + 6) || (u64)(end - p - HEAD) < n) {
      p++; /* not a whole record here: the next one, wherever it starts */
      continue;
    }
    u32 rank = ld32(p + 8), last = ld32(p + 12);
    u64 h = hash(p + HEAD, n);
    if (ld32(p + 16) != sum_of(h, n, rank, last)) {
      p++;
      continue;
    }
    if (!wanted || wanted(p + HEAD, n)) take(p + HEAD, n, h, rank, last);
    p += HEAD + n;
  }
}

/* ---- Where it keeps them, and holding it. */

static char *db;
static u64 dbn;

static void where(void) {
  const char *base = env_data, *tail = "";
  if (!base || !*base) {
    if (env_xdg && *env_xdg) base = env_xdg, tail = "/you";
    else if (env_home && *env_home) base = env_home, tail = "/.local/share/you";
    else fail("nowhere to keep places: set YOU_DATA, XDG_DATA_HOME or HOME", 0);
  }
  u64 a = slen(base), b = slen(tail);
  if (a + b >= PLACE_MAX) fail("where it keeps places is too long", 0);
  dbn = a + b;
  db = (char *)grab(dbn + 1);
  __builtin_memcpy(db, base, a);
  __builtin_memcpy(db + a, tail, b + 1);
}

/* The directories it is kept in, made where they are not (as mkdir -p). */
__attribute__((cold)) static void make_dirs(void) {
  char *d = (char *)grab(dbn + 1);
  __builtin_memcpy(d, db, dbn + 1);
  for (u64 i = 1; i < dbn; i++) {
    if (d[i] != '/') continue;
    d[i] = 0;
    i64 r = sys2(SYS_mkdir, (i64)d, 0755);
    if (r && r != -EEXIST) fail("cannot make the directory for ", d);
    d[i] = '/';
  }
}

/* The file, open (made, with what holds it, when `create`) and held as `how` (flock), and as it is now (`st`): the
 * file there, not one renamed over since it was opened. -1 when there is none and none is to be made. */
static int hold(int create, int how, struct kstat *st) {
  for (int tries = 0;; tries++) {
    int fd = (int)sys3(SYS_open, (i64)db, O_RDWR | O_APPEND | O_CLOEXEC | (create ? O_CREAT : 0), 0644);
    if (fd == -ENOENT && create && !tries) {
      make_dirs();
      continue;
    }
    if (fd == -ENOENT) return -1;
    if (fd < 0) fail("cannot open ", db);
    i64 r;
    while ((r = sys2(SYS_flock, fd, how)) == -EINTR) {}
    if (r) fail("cannot lock ", db);
    if (sys2(SYS_fstat, fd, (i64)st)) fail("cannot read ", db);
    if (st->nlink) return fd;
    sys1(SYS_close, fd); /* remade and renamed over while this waited: the one there now */
  }
}

/* ---- Making the file again: each place once, aged, what is gone forgotten; then renamed over the one held alone. */

__attribute__((cold)) static void remake(const struct kstat *st, u32 now) {
  u8 *z = grab(PLACE_MAX);
  u64 total = 0;
  for (u32 i = 0; i < nplaces; i++) {
    struct place *e = &places[i];
    if (e->gone) continue;
    /* A place not been in for 90 days, and no longer there. */
    if (now - e->last > FORGET_GONE) {
      __builtin_memcpy(z, file + e->at, e->n);
      z[e->n] = 0;
      if (!is_dir(z)) { e->gone = 1; continue; }
    }
    total += e->rank;
  }
  /* Past 10000 in all, each cut by the same part, so that they make 9000; under 1, forgotten. */
  u64 keep = (u64)MAXAGE * 9 / 10;
  /* Beside it, named by this process: no other remakes it while this holds it, and one left by a process stopped
   * before it renamed is written over by the next of its number. */
  char *tmp = (char *)grab(dbn + 24);
  __builtin_memcpy(tmp, db, dbn);
  u64 n = dbn, pid = (u64)sys1(SYS_getpid, 0);
  tmp[n++] = '.';
  char digits[24];
  int k = 0;
  do digits[k++] = (char)('0' + pid % 10), pid /= 10; while (pid);
  while (k) tmp[n++] = digits[--k];
  tmp[n] = 0;
  int w = (int)sys3(SYS_open, (i64)tmp, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, st->mode & 0777);
  if (w < 0) return; /* left as it is: read as well as before, only longer */
  u8 *buf = grab(1 << 16);
  u64 wn = 0;
  int bad = 0;
  for (u32 i = 0; i < nplaces && !bad; i++) {
    struct place *e = &places[i];
    if (e->gone) continue;
    u64 rank = e->rank < (1ull << 40) ? e->rank : (1ull << 40); /* (no product past 64 bits) */
    if (total > MAXAGE) rank = rank * keep / total;
    if (rank < ONE) continue;
    if (rank > 0xffffffffu) rank = 0xffffffffu;
    if (wn + HEAD + e->n > (1 << 16)) {
      if (sys3(SYS_write, w, (i64)buf, (i64)wn) != (i64)wn) bad = 1;
      wn = 0;
    }
    head(buf + wn, e->n, (u32)rank, e->last, e->hash);
    __builtin_memcpy(buf + wn + HEAD, file + e->at, e->n);
    wn += HEAD + e->n;
  }
  if (!bad && wn && sys3(SYS_write, w, (i64)buf, (i64)wn) != (i64)wn) bad = 1;
  /* On the disk before it is renamed over what was: a machine stopped after keeps the one or the other, whole. */
  if (!bad && sys1(SYS_fsync, w)) bad = 1;
  sys1(SYS_close, w);
  if (bad || sys2(SYS_rename, (i64)tmp, (i64)db)) sys1(SYS_unlink, (i64)tmp);
}

/* ---- The time: the kernel's own clock_gettime, in the vDSO it maps into a process (AT_SYSINFO_EHDR), with no call
 * into it. Found by name among the vDSO's symbols (its DT_HASH says how many); where there is none (xlat's processes),
 * the call. */

static const u8 *vdso_at;
static u32 now_s(void) {
  __attribute__((uninitialized)) struct { i64 s, ns; } ts;
  const u8 *b = vdso_at;
  if (b && ld32(b) == 0x464c457fu) { /* \x7fELF */
    u64 phoff = ld64(b + 32), dynv = 0;
    u16 phent = ld16(b + 54), phnum = ld16(b + 56);
    i64 bias = 0;
    int loaded = 0;
    for (u16 i = 0; i < phnum; i++) {
      const u8 *ph = b + phoff + (u64)i * phent;
      u32 type = ld32(ph);
      if (type == 1 && !loaded) bias = (i64)(b + ld64(ph + 8)) - (i64)ld64(ph + 16), loaded = 1; /* PT_LOAD */
      else if (type == 2) dynv = ld64(ph + 16); /* PT_DYNAMIC */
    }
    const u8 *strtab = 0, *symtab = 0, *hashtab = 0;
    for (const u8 *d = loaded && dynv ? (const u8 *)(dynv + (u64)bias) : 0; d && ld64(d); d += 16) {
      u64 tag = ld64(d), at = ld64(d + 8) + (u64)bias;
      if (tag == 5) strtab = (const u8 *)at;
      else if (tag == 6) symtab = (const u8 *)at;
      else if (tag == 4) hashtab = (const u8 *)at;
    }
    for (u32 i = 0, n = strtab && symtab && hashtab ? ld32(hashtab + 4) : 0; i < n; i++) {
      const u8 *sym = symtab + (u64)i * 24;
      if ((sym[4] & 0xf) != 2 || !ld16(sym + 6)) continue; /* a function, defined */
      if (same((const char *)strtab + ld32(sym), "__vdso_clock_gettime")) {
        i64 (*gettime)(i64, void *) = (i64 (*)(i64, void *))(ld64(sym + 8) + (u64)bias);
        if (!gettime(0, &ts)) return (u32)ts.s;
        break;
      }
    }
  }
  sys2(SYS_clock_gettime, 0, (i64)&ts);
  return (u32)ts.s;
}

/* ---- The commands. */

static int add(int argc, char **argv) {
  /* The records, one after another where the arena begins, each place made plain where its record puts it. */
  u8 *recs = arena + used, *r = recs;
  u32 now = 0;
  for (int i = 0; i < argc; i++) {
    if (LEFT - (u64)(r - recs) < HEAD + PLACE_MAX + SLACK + 4096) fail("too many places at once", 0);
    u8 *p = r + HEAD;
    u32 n = plain(argv[i], p);
    if (!n) fail("not a place it can keep: ", argv[i]);
    if (excluded(p, n)) continue;
    int nl = 0;
    for (u32 j = 0; j < n; j++) nl |= p[j] == '\n' || p[j] == '\r';
    if (nl) continue; /* a name a line of output could not hold */
    if (!is_dir(p)) fail("not a directory: ", (const char *)p);
    if (!now) now = now_s();
    head(r, n, ONE, now, hash(p, n));
    r = p + n;
  }
  u64 len = (u64)(r - recs);
  if (!len) return 0;
  grab(len);
  where();
  __attribute__((uninitialized)) struct kstat st;
  int fd = hold(1, LOCK_SH, &st);
  i64 wr;
  while ((wr = sys3(SYS_write, fd, (i64)recs, (i64)len)) == -EINTR) {}
  if (wr != (i64)len) fail("cannot write ", db); /* in part: passed over when read */
  /* The writer that crosses a mark makes it again, holding it alone. */
  if ((u64)st.size / COMPACT_EVERY != ((u64)st.size + len) / COMPACT_EVERY) {
    i64 l;
    while ((l = sys2(SYS_flock, fd, LOCK_EX)) == -EINTR) {}
    if (!l && !sys2(SYS_fstat, fd, (i64)&st) && st.nlink) {
      load(fd);
      remake(&st, now);
    }
  }
  return 0; /* the file closed, and its lock let go, as the process ends */
}

/* ASCII letters made small, eight bytes at a time: a byte from A to Z, and only such, gains 0x20. Into `d` from `s`,
 * both with SLACK after them (the last word written whole). */
static inline u64 lower8(u64 x) {
  const u64 ones = 0x0101010101010101ull, high = 0x8080808080808080ull;
  u64 low7 = x & ~high;
  u64 ge_a = low7 + (0x80 - 'A') * ones; /* high bit: >= 'A' */
  u64 gt_z = low7 + (0x80 - 'Z' - 1) * ones; /* high bit: > 'Z' */
  return x | ((ge_a & ~gt_z & ~x & high) >> 2);
}
static void lower(u8 *d, const u8 *s, u32 n) {
  for (u32 i = 0; i < n; i += 8) st64(d + i, lower8(ld64(s + i)));
}

/* Whether `a` (any case) is `k` (small) in their first n bytes, case aside; both with SLACK after them. */
static inline int eqi(const u8 *a, const u8 *k, u32 n) {
  for (; n >= 8; n -= 8, a += 8, k += 8)
    if (lower8(ld64(a)) != ld64(k)) return 0;
  return !n || !((lower8(ld64(a)) ^ ld64(k)) & (~0ull >> (64 - 8 * n)));
}

/* The last place in `h` (n bytes, any case) where `k` (m bytes, small) is, case aside, or -1; both with SLACK after
 * them. The bytes that are k's first, eight at a time (each such byte of a word exactly, made small as it is read),
 * and the rest of k compared at each of them from the right. */
static i64 rfind(const u8 *h, u32 n, const u8 *k, u32 m) {
  if (m > n) return -1;
  const u64 low7 = 0x7f7f7f7f7f7f7f7full, b = k[0] * 0x0101010101010101ull;
  for (i64 i = (i64)(n - m); i >= 0;) {
    i64 s = i > 7 ? i - 7 : 0;
    u64 x = lower8(ld64(h + s)) ^ b;
    u64 z = ~(((x & low7) + low7) | x | low7); /* the high bit of each byte that is k's first */
    z &= ~0ull >> (8 * (7 - (i - s))); /* none past i */
    while (z) {
      u32 j = (u32)(63 - __builtin_clzll(z)) >> 3;
      if (eqi(h + s + j + 1, k + 1, m - 1)) return s + j;
      z ^= 0x80ull << (8 * j);
    }
    i = s - 1;
  }
  return -1;
}

static const u8 *kw[64];
static u32 kwn[64], nkw;
static const u8 *excl;
static u32 excln;

/* Whether the keywords name `p` (a place, n bytes): each in it, in order, case aside, the last within its last part
 * (nothing after it is a /). */
static int named(const u8 *p, u32 n) {
  i64 at = rfind(p, n, kw[nkw - 1], kwn[nkw - 1]);
  if (at < 0) return 0;
  for (u32 i = (u32)at + kwn[nkw - 1]; i < n; i++)
    if (p[i] == '/') return 0;
  u32 end = (u32)at;
  for (u32 j = nkw - 1; j--;) {
    at = rfind(p, end, kw[j], kwn[j]);
    if (at < 0) return 0;
    end = (u32)at;
  }
  return 1;
}

/* What a query wants of the places the file keeps: not the one excluded, and named by its keywords. */
static int asked(const u8 *p, u32 n) {
  if (n == excln && eq(p, excl, n)) return 0;
  return !nkw || named(p, n);
}

/* How much a place is yours now: its rank by how recently (x4 within the hour, x2 the day, x1/2 the week, x1/4). */
static inline u64 score(const struct place *e, u32 now) {
  u32 age = now - e->last;
  u64 f = age < 3600 ? 16 : age < 86400 ? 8 : age < 604800 ? 2 : 1;
  return e->rank * f;
}

__attribute__((cold)) static void put_score(u64 s) {
  /* As zoxide shows it: the score to a tenth, six wide. In 1/1024ths (a rank's 1/256ths, by four). */
  u64 t = (s * 10 + 512) / 1024;
  char b[24];
  int n = 0;
  b[n++] = (char)('0' + t % 10), b[n++] = '.', t /= 10;
  do b[n++] = (char)('0' + t % 10), t /= 10; while (t);
  while (n < 6) b[n++] = ' ';
  char o[24];
  for (int i = 0; i < n; i++) o[i] = b[n - 1 - i];
  o[n] = ' ';
  put(o, (u64)n + 1);
}

/* The candidates (places named) and their scores, in the arena after the file; in order of their scores, least
 * first (a heap, taken from). */
static u32 *cand;
static u64 *cscore;
__attribute__((cold)) static void sift(u32 i, u32 n) {
  for (;;) {
    u32 l = 2 * i + 1, m = i;
    if (l < n && cscore[l] > cscore[m]) m = l;
    if (l + 1 < n && cscore[l + 1] > cscore[m]) m = l + 1;
    if (m == i) return;
    u32 c = cand[i]; cand[i] = cand[m], cand[m] = c;
    u64 s = cscore[i]; cscore[i] = cscore[m], cscore[m] = s;
    i = m;
  }
}
__attribute__((cold)) static void sort(u32 n) {
  for (u32 i = n / 2; i--;) sift(i, n);
  for (u32 k = n; k > 1; k--) {
    u32 c = cand[0]; cand[0] = cand[k - 1], cand[k - 1] = c;
    u64 s = cscore[0]; cscore[0] = cscore[k - 1], cscore[k - 1] = s;
    sift(0, k - 1);
  }
}

/* Candidate `j` written out, when it is still a directory (`z`, room for a place); whether it was. */
static int give(u32 j, int show, u8 *z) {
  const struct place *e = &places[cand[j]];
  __builtin_memcpy(z, file + e->at, e->n);
  z[e->n] = 0;
  if (!is_dir(z)) return 0;
  if (show) put_score(cscore[j]);
  z[e->n] = '\n';
  put(z, e->n + 1);
  return 1;
}

static int query(int argc, char **argv) {
  int list = 0, show = 0;
  const char *exclude = 0;
  int i = 0;
  for (; i < argc; i++) {
    const char *a = argv[i];
    if (a[0] != '-') break;
    if (same(a, "--")) { i++; break; }
    if (same(a, "--list") || same(a, "-l")) list = 1;
    else if (same(a, "--score") || same(a, "-s")) show = 1;
    else if (same(a, "--exclude")) { if (++i == argc) fail("--exclude wants a place", 0); exclude = argv[i]; }
    else if (!memcmp(a, "--exclude=", 10)) exclude = a + 10;
    else fail("no such option: ", a);
  }
  /* The keywords, made small. */
  for (; i < argc; i++) {
    u32 m = (u32)slen(argv[i]);
    if (!m) continue;
    if (nkw == 64 || m >= PLACE_MAX) fail("too many keywords, or one too long", 0);
    u8 *k = grab(m);
    __builtin_memcpy(k, argv[i], m);
    lower(k, k, m);
    kw[nkw] = k, kwn[nkw++] = m;
  }
  if (exclude) {
    u8 *x = grab(PLACE_MAX);
    excln = plain(exclude, x), excl = x;
  }
  u8 *z = grab(PLACE_MAX); /* a place written out */
  where();
  /* Only what is named is added up: a place's records are all named, or none. */
  wanted = asked;
  int fd = (int)sys3(SYS_open, (i64)db, O_RDONLY | O_CLOEXEC, 0);
  if (fd >= 0) load(fd); /* (closed as the process ends) */
  cand = (u32 *)grab(nplaces * 4ul), cscore = (u64 *)grab(nplaces * 8ul);
  u32 now = now_s(), nc = 0;
  for (u32 j = 0; j < nplaces; j++) cand[nc] = j, cscore[nc++] = score(&places[j], now);
  /* The most yours first, each still a directory: all of them, or the first there (the best found in one pass, and
   * again past one gone). */
  int found = 0;
  if (list) {
    sort(nc);
    for (u32 j = nc; j--;) found |= give(j, show, z);
  } else {
    while (nc && !found) {
      u32 best = 0;
      for (u32 j = 1; j < nc; j++)
        if (cscore[j] > cscore[best]) best = j;
      found = give(best, show, z);
      cand[best] = cand[--nc], cscore[best] = cscore[nc];
    }
  }
  flush();
  if (!found) fail("no match", 0);
  return 0;
}

__attribute__((cold)) static int remove_(int argc, char **argv) {
  if (!argc) return 0;
  where();
  __attribute__((uninitialized)) struct kstat st;
  int fd = hold(0, LOCK_EX, &st);
  if (fd < 0) fail("not kept: ", argv[0]);
  load(fd);
  u8 *p = grab(PLACE_MAX);
  for (int i = 0; i < argc; i++) {
    u32 n = plain(argv[i], p);
    struct place *e = n ? find(p, n) : 0;
    if (!e || e->gone) fail("not kept: ", argv[i]);
    e->gone = 1;
  }
  remake(&st, now_s());
  return 0;
}

static const char usage[] =
  "usage: you add DIR...\n"
  "       you query [--list] [--score] [--exclude DIR] [--] [KEYWORD...]\n"
  "       you remove DIR...\n";

static int main_(int argc, char **argv, char **envp) {
  read_env(envp);
  if (argc < 2) { sys3(SYS_write, 2, (i64)usage, sizeof usage - 1); return 2; }
  const char *c = argv[1];
  int n = argc - 2;
  char **a = argv + 2;
  if (same(c, "add")) {
    if (n && same(a[0], "--")) a++, n--;
    return add(n, a);
  }
  if (same(c, "query")) return query(n, a);
  if (same(c, "remove")) {
    if (n && same(a[0], "--")) a++, n--;
    return remove_(n, a);
  }
  if (same(c, "--help") || same(c, "-h")) { sys3(SYS_write, 1, (i64)usage, sizeof usage - 1); return 0; }
  sys3(SYS_write, 2, (i64)usage, sizeof usage - 1);
  return 2;
}

/* ---- Where the kernel starts it: the stack it was given (argc, argv, envp, the auxiliary vector), the guard set
 * from AT_RANDOM, then main. */

__attribute__((noreturn, used, no_stack_protector)) void start(u64 *sp) {
  int argc = (int)sp[0];
  char **argv = (char **)(sp + 1), **envp = argv + argc + 1;
  u64 *aux = (u64 *)envp;
  while (*aux++) {}
  for (; aux[0]; aux += 2) {
    if (aux[0] == 25) __stack_chk_guard = ld64((const u8 *)aux[1]) & ~0xffull; /* AT_RANDOM; a zero byte first, as libcs do */
    else if (aux[0] == 33) vdso_at = (const u8 *)aux[1]; /* AT_SYSINFO_EHDR */
  }
  leave(main_(argc, argv, envp));
}

__asm__(
  ".text\n"
  ".global _start\n"
  ".type _start, @function\n"
  "_start:\n"
  "  xor %ebp, %ebp\n"
  "  mov %rsp, %rdi\n"
  "  and $-16, %rsp\n"
  "  call start\n"
  "  hlt\n");
