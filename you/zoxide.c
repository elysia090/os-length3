/*
 * you's zoxide: the places you have been, and back to one by a part of its name (zoxide's, made again as one unit of
 * a unit of C: lib's three headers and this; its checks in test/).
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
 * (newfstatat, open, flock, fstat, write), reading nothing, and finding one four (open, pread, newfstatat, writev).
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
 * Every 16 KiB appended, the writer that crosses the mark has it made again, by a child of its own (so that a cd
 * waits for its one write, not for this): each place once, aged (past 10000 in all, each rank cut so that they make
 * 9000, a place under 1 forgotten), a place gone for 90 days forgotten, written to a file beside it, fsync'd, and
 * renamed over it. Learners hold the file shared (flock) while they append and the one
 * remaking it holds it alone, so nothing is appended to a file being remade; one that waited on it finds what it
 * holds no longer there (fstat: no link) and opens it again. Readers take no lock: the file they read is whole, or
 * whole but for a record still being written at its end, which they leave. `sum` makes each record its own check:
 * one written in part (a disk full, a machine stopped) is passed over, and the next whole one found again.
 */

#define UNIT "you"
#include "../lib/word.h"
#include "../lib/sys.h"
#include "../lib/io.h"

/* ---- The environment: the few names it reads. */

static const char *env_home, *env_xdg, *env_data, *env_exclude;
#ifdef YOU_TEST_CLOCK /* (a test's build: its time is $YOU_NOW, when set) */
static const char *env_now;
#endif

static void read_env(char **envp) {
  for (char **e = envp; *e; e++) {
    const char *s = *e;
    switch (s[0]) {
      case 'H': if (s[1] == 'O' && s[2] == 'M' && s[3] == 'E' && s[4] == '=') env_home = s + 5; break;
      case 'X': if (!memcmp(s, "XDG_DATA_HOME=", 14)) env_xdg = s + 14; break;
      case 'Y':
        if (!memcmp(s, "YOU_DATA=", 9)) env_data = s + 9;
        else if (!memcmp(s, "YOU_EXCLUDE=", 12)) env_exclude = s + 12;
#ifdef YOU_TEST_CLOCK
        else if (!memcmp(s, "YOU_NOW=", 8)) env_now = s + 8;
#endif
        break;
    }
  }
}

/* ---- Places: made absolute and plain as a shell's $PWD is (no ., .., // or trailing /), no symlink followed. */

#define PLACE_MAX 4096

/* `in`, made plain into `o` (room for PLACE_MAX bytes and SLACK) and NUL-terminated; its length, or 0 when it cannot
 * be (too long, or the working directory unknown). */
static int plain_line; /* whether the place plain made has a line's end in it: 1, 0, or -1, not seen */
static u32 plain(const char *in, u8 *o) {
  /* What a shell's $PWD is, at once: absolute, and no / at its end, after another, or before a . or .. that is a part
   * of it (a part that only begins with a dot, as .config, is as any other): copied whole, then looked through a word
   * at a time for what would make it otherwise. */
  u64 len = slen(in);
  plain_line = -1;
  if (in[0] == '/' && len < PLACE_MAX) {
    memcpy(o, in, len);
    st64(o + len, 0);
    int odd = len > 1 && o[len - 1] == '/';
    u64 nl = 0;
    for (u64 i = 0, carry = 0; i < len && !odd; i += 8) {
      u64 w = ld64(o + i), sl = zeros(w ^ ('/' * ONES)), dot = zeros(w ^ ('.' * ONES));
      nl |= zeros(w ^ ('\n' * ONES)) | zeros(w ^ ('\r' * ONES)); /* (and a line's end, which add asks of it) */
      u64 c = (sl << 8 | carry) & (sl | dot); /* each byte after a /, that is a / or a . */
      carry = sl >> 56;
      for (; c && !odd; c &= c - 1) {
        const u8 *b = o + i + (__builtin_ctzll(c) >> 3);
        odd = b[0] == '/' || ((b[1] == '/' || !b[1]) || (b[1] == '.' && (b[2] == '/' || !b[2])));
      }
    }
    if (!odd) return plain_line = nl != 0, (u32)len;
  }
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
#ifndef COMPACT_EVERY /* (a test's build makes it again more often: test/zoxide-stress.sh) */
#define COMPACT_EVERY 16384
#endif
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
  for (const u8 *e = p + (n & ~31u); p != e; p += 32) { /* (two turns of 16 at a time: half the counting) */
    a = rotl((a ^ ld64(p)) * k2, 29), b = rotl((b ^ ld64(p + 8)) * k1, 31);
    a = rotl((a ^ ld64(p + 16)) * k2, 29), b = rotl((b ^ ld64(p + 24)) * k1, 31);
  }
  if (n & 16) a = rotl((a ^ ld64(p)) * k2, 29), b = rotl((b ^ ld64(p + 8)) * k1, 31), p += 16;
  if (n & 8) a = rotl((a ^ ld64(p)) * k2, 29), p += 8;
  if (n & 7) b = rotl((b ^ (ld64(p) & (~0ull >> (64 - 8 * (n & 7))))) * k1, 31);
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
static int asked(const u8 *p, u32 n);
static int querying; /* only what a query asks for (asked), not all */
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
    /* Its head in two words: the tag, then its length and the 0 after it as one u32 (so 0, past the longest place,
     * or a 0 that is not, are each out of 1 to PLACE_MAX - 1); then its rank and when. */
    u64 h0 = ld64(p), h1 = ld64(p + 8);
    u32 n = (u32)(h0 >> 32);
    u64 h;
    if ((u32)h0 == TAG && n - 1 < PLACE_MAX - 1 && (u64)(end - p - HEAD) >= n &&
        ld32(p + 16) == sum_of(h = hash(p + HEAD, n), n, (u32)h1, (u32)(h1 >> 32))) {
      if (!querying || asked(p + HEAD, n)) take(p + HEAD, n, h, (u32)h1, (u32)(h1 >> 32));
      p += HEAD + n;
      continue;
    }
    /* Not a whole record here: the next one, wherever it starts, from the next "y" its tag begins with (what is read
     * past the end is SLACK, zeros). */
    const u8 *q = p + 1;
    u64 c;
    while (q < end && !(c = zeros(ld64(q) ^ ('y' * ONES)))) q += 8;
    p = q < end ? q + (__builtin_ctzll(c) >> 3) : end;
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
  if (!*tail) { /* $YOU_DATA, as it is (its length, only when wanted: db_len) */
    db = (char *)base;
    return;
  }
  u64 a = slen(base), b = slen(tail);
  if (a + b >= PLACE_MAX) fail("where it keeps places is too long", 0);
  dbn = a + b;
  db = (char *)grab(dbn + 1);
  __builtin_memcpy(db, base, a);
  __builtin_memcpy(db + a, tail, b + 1);
}
static u64 db_len(void) {
  if (!dbn) dbn = slen(db);
  return dbn;
}

/* The directories it is kept in, made where they are not (as mkdir -p). */
__attribute__((cold)) static void make_dirs(void) {
  u64 dn = db_len();
  char *d = (char *)grab(dn + 1);
  __builtin_memcpy(d, db, dn + 1);
  for (u64 i = 1; i < dn; i++) {
    if (d[i] != '/') continue;
    d[i] = 0;
    i64 r = sys2(SYS_mkdir, (i64)d, 0755);
    if (r && r != -EEXIST) fail("cannot make the directory for ", d);
    d[i] = '/';
  }
}

/* Hold `fd` as `how` (flock), waiting as long as it takes; 0, or why not. Where the file system cannot hold a file
 * (NFS without its lock daemon), it goes on without: a visit is still appended whole, and the file still remade, though
 * a visit appended while it is remade may be lost. */
static i64 lock(int fd, int how) {
  i64 r;
  while ((r = sys2(SYS_flock, fd, how)) == -EINTR) {}
  return r == -ENOLCK || r == -ENOSYS || r == -EOPNOTSUPP || r == -EINVAL ? 0 : r;
}

/* The file, open (made, with what holds it, when `create`) and held as `how` (flock), and as it is now (`st`): the
 * file there, not one renamed over since it was opened, and a file (not a FIFO, which would hold a learner, or
 * anything else). -1 when there is none and none is to be made. */
static int hold(int create, int how, struct kstat *st) {
  for (int tries = 0;; tries++) {
    int fd = (int)sys3(SYS_open, (i64)db, O_RDWR | O_APPEND | O_CLOEXEC | (create ? O_CREAT : 0), 0644);
    if (fd == -ENOENT && create && !tries) {
      make_dirs();
      continue;
    }
    if (fd == -ENOENT) return -1;
    if (fd < 0) fail("cannot open ", db);
    if (lock(fd, how)) fail("cannot lock ", db);
    if (sys2(SYS_fstat, fd, (i64)st)) fail("cannot read ", db);
    if (!IS_REG(st->mode)) fail("not a file: ", db);
    if (st->nlink) return fd;
    sys1(SYS_close, fd); /* remade and renamed over while this waited: the one there now */
  }
}

/* ---- Making the file again: each place once, aged, what is gone forgotten; then renamed over the one held alone. */

/* What remaking works in, taken before the file is read (which may take all the room there is left). */
static u8 *rz, *rbuf;
static char *rtmp;
__attribute__((cold)) static void ready(void) {
  rz = grab(PLACE_MAX), rtmp = (char *)grab(db_len() + 5), rbuf = grab(1 << 16);
}

/* Whether it was made again (else it is as it was). */
__attribute__((cold)) static int remake(const struct kstat *st, u32 now) {
  u8 *z = rz;
  u64 total = 0;
  for (u32 i = 0; i < nplaces; i++) {
    struct place *e = &places[i];
    if (e->gone) continue;
    /* A place not been in for 90 days, and no longer there. */
    if (now > e->last && now - e->last > FORGET_GONE) {
      __builtin_memcpy(z, file + e->at, e->n);
      z[e->n] = 0;
      if (!is_dir(z)) { e->gone = 1; continue; }
    }
    total += e->rank;
  }
  /* Past 10000 in all, each cut by the same part, so that they make 9000; under 1, forgotten. */
  u64 keep = (u64)MAXAGE * 9 / 10;
  /* Beside it, as <it>.new: only the one holding the file there alone remakes it, so no two write this at once, and
   * one left by a process stopped before it renamed is written over by the next remaking (one such, at most). */
  char *tmp = rtmp;
  __builtin_memcpy(tmp, db, db_len());
  __builtin_memcpy(tmp + dbn, ".new", 5);
  int w = (int)sys3(SYS_open, (i64)tmp, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, st->mode & 0777);
  if (w < 0) return 0; /* left as it is: read as well as before, only longer */
  u8 *buf = rbuf;
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
  if (!bad && !sys2(SYS_rename, (i64)tmp, (i64)db)) return 1;
  sys1(SYS_unlink, (i64)tmp);
  return 0;
}

/* ---- The time (sys.h), or a test's: its build reads $YOU_NOW when set. */

static u32 now_s(void) {
#ifdef YOU_TEST_CLOCK
  if (env_now) {
    u32 t = 0;
    for (const char *c = env_now; *c >= '0' && *c <= '9'; c++) t = t * 10 + (u32)(*c - '0');
    return t;
  }
#endif
  return clock_s();
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
    if (plain_line < 0 ? line_in(p, n) : plain_line) continue; /* a name a line of output could not hold */
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
  /* The writer that crosses a mark has it made again, held alone: by a child of its own, so that what ran it (a shell,
   * at a cd) waits for its visit, one write, and not for the remaking (a fsync and the whole file written). The parent
   * ends once the child holds the file alone, as it says by closing a pipe (or by ending), so whatever holds the file
   * after the parent ended waits for the remaking (flock it to know it done). The child's standard input and output are
   * nothing, so it holds open no pipe that what ran it reads to its end. Where there can be no child, it remakes it
   * itself. */
  if ((u64)st.size / COMPACT_EVERY != ((u64)st.size + len) / COMPACT_EVERY) {
    int pp[2];
    i64 pid = -1;
    if (!sys2(SYS_pipe2, (i64)pp, O_CLOEXEC) && (pid = sys1(SYS_fork, 0)) < 0) sys1(SYS_close, pp[0]), sys1(SYS_close, pp[1]);
    if (pid > 0) {
      sys1(SYS_close, pp[1]);
      u8 b;
      while (sys3(SYS_read, pp[0], (i64)&b, 1) == -EINTR) {}
      return 0;
    }
    if (!pid) {
      int nul = (int)sys3(SYS_open, (i64)"/dev/null", O_RDWR, 0);
      for (int f = 0; f < 3; f++)
        if (nul < 0) sys1(SYS_close, f);
        else if (nul != f) sys2(SYS_dup2, nul, f);
    }
    int held = !lock(fd, LOCK_EX) && !sys2(SYS_fstat, fd, (i64)&st) && st.nlink;
    if (!pid) sys1(SYS_close, pp[1]); /* the parent ends */
    if (held) {
      ready();
      load(fd);
      remake(&st, now);
    }
  }
  return 0; /* the file closed, and its lock let go, as the process ends */
}

/* The last place in `h` (n bytes, any case) where `k` (m bytes, small) is, case aside, or -1; both with SLACK after
 * them. Eight places at a time, from the right, those where both k's first byte and its last are (each byte taken
 * with 0x20 set, which a letter is in either case: a byte it would not match may pass, one it would never fails),
 * then the whole of k compared at each of them, the rightmost first. */
static const u8 *kw[64];
static u32 kwn[64], nkw;
static u64 kwa[64], kwz[64]; /* each keyword's first byte and last, with 0x20 set, in every byte of a word */
#define UP (0x20 * ONES)
__attribute__((always_inline)) static inline i64 rfind(const u8 *h, u32 n, u32 kj) {
  const u8 *k = kw[kj];
  u32 m = kwn[kj];
  if (m > n) return -1;
  const u64 a = kwa[kj], z = kwz[kj];
  for (i64 i = (i64)(n - m); i >= 0;) {
    i64 s = i > 7 ? i - 7 : 0;
    u64 c = zeros(((ld64(h + s) | UP) ^ a) | ((ld64(h + s + m - 1) | UP) ^ z));
    c &= ~0ull >> (8 * (7 - (i - s))); /* none past i */
    while (c) {
      u32 j = (u32)(63 - __builtin_clzll(c)) >> 3;
      if (eqi(h + s + j, k, m)) return s + j;
      c ^= 0x80ull << (8 * j);
    }
    i = s - 1;
  }
  return -1;
}

static const u8 *excl;
static u32 excln;

/* Whether the keywords name `p` (a place, n bytes): each in it, in order, case aside, the last within its last part
 * (nothing after it is a /). So the last is looked for only where it would end past the last /: from as far before
 * it as the keyword is long, less one. */
static int named(const u8 *p, u32 n) {
  u32 m = kwn[nkw - 1], ls = last_slash(p, n), lo = ls + 1 > m ? ls + 1 - m : 0;
  i64 at = rfind(p + lo, n - lo, nkw - 1);
  if (at < 0) return 0;
  u32 end = lo + (u32)at;
  for (u32 j = nkw - 1; j--;) {
    i64 at = rfind(p, end, j);
    if (at < 0) return 0;
    end = (u32)at;
  }
  return 1;
}

/* A character small, as Rust's to_lowercase makes it (zoxide's case aside), where that keeps its UTF-8 length: Latin-1's
 * capitals, Latin Extended-A's, Greek's, Cyrillic's, Armenian's and the fullwidth Latin ones; any other as it is. */
static u32 small(u32 c) {
  if (c >= 0xC0 && c <= 0xDE && c != 0xD7) return c + 32;
  if (c >= 0x100 && c <= 0x17F) {
    if (c == 0x130 || c == 0x131 || c == 0x138 || c == 0x149 || c == 0x17F) return c;
    if (c == 0x178) return 0xFF;
    if ((c >= 0x139 && c <= 0x148) || (c >= 0x179 && c <= 0x17E)) return c & 1 ? c + 1 : c;
    return c & 1 ? c : c + 1;
  }
  if (c >= 0x391 && c <= 0x3AB && c != 0x3A2) return c + 32;
  if (c == 0x386) return 0x3AC;
  if (c >= 0x388 && c <= 0x38A) return c + 37;
  if (c == 0x38C) return 0x3CC;
  if (c == 0x38E || c == 0x38F) return c + 63;
  if (c >= 0x410 && c <= 0x42F) return c + 32;
  if (c >= 0x400 && c <= 0x40F) return c + 80;
  if ((c >= 0x460 && c <= 0x481) || (c >= 0x48A && c <= 0x4BF) || (c >= 0x4D0 && c <= 0x52F)) return c & 1 ? c : c + 1;
  if (c == 0x4C0) return 0x4CF;
  if (c >= 0x4C1 && c <= 0x4CE) return c & 1 ? c + 1 : c;
  if (c >= 0x531 && c <= 0x556) return c + 48;
  if (c >= 0xFF21 && c <= 0xFF3A) return c + 32;
  return c;
}
/* s[0..n) made small into d (the same length): ASCII's capitals, and those past it small() knows. */
static void small_text(u8 *d, const u8 *s, u32 n) {
  for (u32 i = 0; i < n;) {
    u8 b = s[i];
    if (b >= 0xC2 && b <= 0xDF && i + 1 < n && (s[i + 1] & 0xC0) == 0x80) {
      u32 c = small((u32)(b & 0x1F) << 6 | (s[i + 1] & 0x3F));
      d[i] = (u8)(0xC0 | c >> 6), d[i + 1] = (u8)(0x80 | (c & 0x3F)), i += 2;
    } else if (b == 0xEF && i + 2 < n && (s[i + 1] & 0xC0) == 0x80 && (s[i + 2] & 0xC0) == 0x80) {
      u32 c = small((u32)(b & 0x0F) << 12 | (u32)(s[i + 1] & 0x3F) << 6 | (s[i + 2] & 0x3F));
      d[i] = (u8)(0xE0 | c >> 12), d[i + 1] = (u8)(0x80 | ((c >> 6) & 0x3F)), d[i + 2] = (u8)(0x80 | (c & 0x3F)), i += 3;
    } else d[i] = b >= 'A' && b <= 'Z' ? b + 32 : b, i++;
  }
}

/* What a query wants of the places the file keeps: not the one excluded, and named by its keywords. A keyword past
 * ASCII is looked for in the place made small as zoxide makes it (über in /home/Über), a copy; else in the place as it
 * is, its ASCII letters taken either way as they are compared. */
static int wide;
static u8 *smaller;
static int asked(const u8 *p, u32 n) {
  if (n == excln && eq(p, excl, n)) return 0;
  if (!nkw) return 1;
  if (!wide) return named(p, n);
  small_text(smaller, p, n);
  return named(smaller, n);
}

/* How much a place is yours now: its rank by how recently (x4 within the hour, x2 the day, x1/2 the week, x1/4). */
static inline u64 score(const struct place *e, u32 now) {
  u32 age = now > e->last ? now - e->last : 0; /* (a clock gone back: now) */
  u64 f = age < 3600 ? 16 : age < 86400 ? 8 : age < 604800 ? 2 : 1;
  return e->rank * f;
}

/* The candidates (places named), each its score and which place it is in one word, so that the greater is the more
 * yours, and of two as much, the one first in the file (as it was learnt first): the score (at most 2^50 - 1, past all
 * a file can add up to) above, the place's index (under PLACES_MAX, 2^14) turned over below. */
static u64 key[PLACES_MAX];
#define KEY(score, i) ((score) < (1ull << 50) ? (score) << 14 | (PLACES_MAX - 1 - (i)) : ~0ull << 14 | (PLACES_MAX - 1 - (i)))
/* In order, least first: by each byte of the keys, the lowest first, each pass keeping the order of the one before;
 * only the bytes in which the keys differ (where all of them and any of them are not alike: the place's index, and of
 * the score what its magnitudes reach), each counted, then laid out. */
static u64 key2[PLACES_MAX];
static u32 counts[256];
__attribute__((cold)) static void sort(u32 n) {
  u64 any = 0, all = ~0ull;
  for (u32 i = 0; i < n; i++) any |= key[i], all &= key[i];
  u64 *a = key, *b = key2;
  for (u32 sh = 0; sh < 64; sh += 8) {
    if (!(u8)((any ^ all) >> sh)) continue;
    memset(counts, 0, sizeof counts);
    for (u32 i = 0; i < n; i++) counts[(u8)(a[i] >> sh)]++;
    for (u32 v = 0, at = 0; v < 256; v++) {
      u32 t = counts[v];
      counts[v] = at, at += t;
    }
    for (u32 i = 0; i < n; i++) b[counts[(u8)(a[i] >> sh)]++] = a[i];
    u64 *t = a;
    a = b, b = t;
  }
  if (a != key) memcpy(key, a, n * 8ul);
}

/* The candidate `k` written out, its score first when `show`, when it is still a directory; whether it was. The
 * place as it was read, made a name to be asked of, then a line, where it is: the byte after it is the next record's,
 * whose head, the file read, is wanted no more (or SLACK, after the last). */
static int give(u64 k, int show) {
  const struct place *e = &places[PLACES_MAX - 1 - (k & (PLACES_MAX - 1))];
  u8 *z = file + e->at;
  z[e->n] = 0;
  if (!is_dir(z)) return 0;
  z[e->n] = '\n';
  if (show) {
    /* As zoxide shows it: the score to a tenth, six wide, a tie to even. In 1/1024ths (a rank's 1/256ths, by four). */
    /* (written from its end back, into the next 32 bytes of `text`) */
    u64 s = k >> 14, t = (s * 10 + 512) >> 10;
    if ((s * 10 & 1023) == 512 && t & 1) t--;
    u8 *e = text + textn + 32, *o = e;
    *--o = ' ', *--o = (u8)('0' + t % 10), *--o = '.', t /= 10;
    do *--o = (u8)('0' + t % 10), t /= 10; while (t);
    while (e - o < 7) *--o = ' ';
    textn += 32;
    put(o, (u64)(e - o));
  }
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
    for (u32 b = 0; b < m; b++) wide |= k[b] >= 0x80;
    if (wide) small_text(k, k, m);
    kwa[nkw] = (k[0] | 0x20) * ONES, kwz[nkw] = (k[m - 1] | 0x20) * ONES;
    kw[nkw] = k, kwn[nkw++] = m;
  }
  if (exclude) {
    u8 *x = grab(PLACE_MAX);
    excln = plain(exclude, x), excl = x;
  }
  if (wide) smaller = grab(PLACE_MAX + SLACK);
  where();
  /* Only what is named is added up: a place's records are all named, or none. */
  querying = 1;
  /* (not waiting on a FIFO there: what is not a file reads as nothing) */
  int fd = (int)sys3(SYS_open, (i64)db, O_RDONLY | O_NONBLOCK | O_CLOEXEC, 0);
  if (fd >= 0) load(fd); /* (closed as the process ends) */
  u32 now = now_s(), nc = nplaces;
  for (u32 j = 0; j < nc; j++) key[j] = KEY(score(&places[j], now), j);
  /* The most yours first, each still a directory: all of them, or the first there (the best found in one pass, and
   * again past one gone). */
  int found = 0;
  if (list) {
    sort(nc);
    for (u32 j = nc; j--;) found |= give(key[j], show);
  } else {
    while (nc && !found) {
      u32 best = 0;
      for (u32 j = 1; j < nc; j++) best = key[j] > key[best] ? j : best;
      found = give(key[best], show);
      key[best] = key[--nc];
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
  ready();
  u8 *p = grab(PLACE_MAX);
  load(fd);
  for (int i = 0; i < argc; i++) {
    u32 n = plain(argv[i], p);
    struct place *e = n ? find(p, n) : 0;
    if (!e || e->gone) fail("not kept: ", argv[i]);
    e->gone = 1;
  }
  if (!remake(&st, now_s())) fail("cannot write ", db);
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
