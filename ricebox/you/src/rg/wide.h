/* ---- More processes than one. A walk that has searched sixteen files goes on as several processes, each from
 * where the walk is (a directory is read whole before any of its files is searched, so none shares a place in one
 * with another). The walk is so many turns, and a turn is a file, or a directory with all that is below it: one
 * two levels down or deeper whose own directory holds eight entries or more. Each process comes to the turns in
 * the walk's order and takes the first no other has taken (a word for each turn, in memory they share), so one
 * that is long at a turn holds no other up: the rest go by it and take what comes after. A directory that is a
 * turn is opened by the process that took it and by no other, so the tree is walked once among them, not once by
 * each; what lies above (the first two levels, and a chain of directories that each hold little: src/main/java)
 * every one of them walks, and it is little.
 * What each prints goes to the process that began the walk, which searches nothing more: it takes the first
 * turn's output from whoever took the first, the next from whoever took the next, in the walk's order, so what
 * is printed is what one process would print, byte for byte. A walk of fewer files is one process, as it was.
 *
 * What goes between them, on a pipe each: frames, each a word (its kind in the top three bits, a length or a few
 * flags below) and, for output, that many bytes. A file's output; where the file's heading comes (whether a blank
 * line goes before it is whether a file before it printed, which another process knows: the one that orders says
 * it); where its first line among context comes (the separator between files, likewise); the file's end, saying
 * whether it printed and whether it printed with context; and at the walk's end what the process found.
 *
 * As many as the cores this process may run on (eight at most; -j N says). Processes, not threads: what a file's
 * search holds (the walk's stack, the path, what is being printed) is each one's own without a word of it changed. */
enum { SYS_wait4 = 61, SYS_kill = 62, SYS_fcntl = 72, SYS_splice = 275 };
#define WIDE_AFTER 16
enum { F_DATA = 0, F_HEAD = 1u << 29, F_SEP = 2u << 29, F_END = 3u << 29, F_DONE = 4u << 29, F_KIND = 7u << 29 };
static u32 kids, me;   /* how many search (0: this one alone), and which of them this is */
/* What they share: for each turn, who took it (its number and one; 0: no one yet), and how many turns the walk came
 * to, said by the first to end it (and one). A turn past the last word there is (a walk of millions) goes by its
 * number. */
enum { TURNS = 1u << 22 };
static struct { u32 total, pad; u32 taker[TURNS]; } *shared;
static u64 turn;       /* the files come to since they were made: the next one's number */
static int wide_fd;    /* where this one's frames go */
static int in_turn;    /* a turn of this one's is being searched: what the walk comes to within it is all its own */
static int sep_asked, head_asked; /* this turn's first line among context, and its first heading, have been come to */
static u64 searched;   /* how many files were searched: none, where no path was named, is said */
static int printed_any, last_ctx_file; /* whether a file before this printed, and printed with context (print.h) */
static struct grep g;                 /* the search (print.h) */

/* All of v[0..k) written to fd (a pipe may take a part: the rest then). */
static void wide_all(int fd, struct iovec *v, u32 k) {
  while (k) {
    i64 r = sys3(SYS_writev, fd, (i64)v, k < 1024 ? k : 1024); /* (as many pieces as one call takes: a frame's word made them one more) */
    if (r == -EINTR) continue;
    if (r <= 0) leave(1);
    for (; k && (u64)r >= v->len; v++, k--) r -= (i64)v->len;
    if (k) v->base = (const u8 *)v->base + r, v->len -= (u64)r;
  }
}
/* What flush writes by (lib/io.h IO_WRITEV): standard output, or one frame of output to the one that orders. */
static long rg_writev(struct iovec *v, unsigned k) {
  if (!kids) return sys3(SYS_writev, 1, (i64)v, k);
  static struct iovec framed[IOV + 1];
  u64 total = 0;
  for (u32 i = 0; i < k; i++) framed[i + 1] = v[i], total += v[i].len;
  if (total >= F_HEAD) { /* (more than a frame says: a piece at a time, each its own frames) */
    for (u32 i = 0; i < k; i++)
      for (u64 at = 0; at < v[i].len;) {
        u32 n = v[i].len - at < (F_HEAD >> 1) ? (u32)(v[i].len - at) : F_HEAD >> 1;
        struct iovec two[2] = {{&n, 4}, {(const u8 *)v[i].base + at, n}};
        wide_all(wide_fd, two, 2);
        at += n;
      }
    return (long)total;
  }
  u32 head = (u32)total;
  framed[0].base = &head, framed[0].len = 4;
  wide_all(wide_fd, framed, k + 1);
  return (long)total;
}
/* A frame that is a word alone, after what was put before it. */
static void wide_mark(u32 word) {
  flush();
  struct iovec one = {&word, 4};
  wide_all(wide_fd, &one, 1);
}
__attribute__((noreturn)) static void wide_done(void) {
  /* How many turns there were, said by the first to know; the one that orders, waiting at the turn past the last. */
  u32 none = 0;
  if (__atomic_compare_exchange_n(&shared->total, &none, (u32)(turn < TURNS ? turn : TURNS) + 1, 0, __ATOMIC_ACQ_REL, __ATOMIC_RELAXED) && turn < TURNS)
    sys3(SYS_futex, (i64)&shared->taker[turn], 1 /* FUTEX_WAKE */, 1);
  struct { u32 word, found, errors, pad; u64 searched; } said = {F_DONE, (u32)found, (u32)errors, 0, searched};
  struct iovec one = {&said, sizeof said};
  wide_all(wide_fd, &one, 1);
  leave(0);
}

/* Whether the next turn is this one's; then it has begun (what a file before it printed is not known here). */
static int wide_turn(void) {
  u64 i = turn++;
  if (i >= TURNS) { if (i % kids != me) return 0; }
  else {
    u32 none = 0;
    if (!__atomic_compare_exchange_n(&shared->taker[i], &none, me + 1, 0, __ATOMIC_ACQ_REL, __ATOMIC_RELAXED)) return 0;
    sys3(SYS_futex, (i64)&shared->taker[i], 1 /* FUTEX_WAKE */, 1); /* (the one that orders may be waiting to know) */
  }
  printed_any = last_ctx_file = sep_asked = head_asked = 0;
  return 1;
}
/* The turn's end: whether it printed, and whether it ended on a file printed with context. */
static void wide_turned(void) { wide_mark(F_END | (printed_any ? 1u : 0) | (last_ctx_file ? 2u : 0)); }

/* n bytes from fd, all of them: 0 where it ended before them. */
static int wide_read(int fd, void *into, u64 n) {
  for (u64 at = 0; at < n;) {
    i64 r = sys3(SYS_read, fd, (i64)((u8 *)into + at), (i64)(n - at));
    if (r == -EINTR) continue;
    if (r <= 0) return 0;
    at += (u64)r;
  }
  return 1;
}
static void wide_out(const void *p, u64 n) {
  for (u64 at = 0; at < n;) {
    i64 r = sys3(SYS_write, 1, (i64)((const u8 *)p + at), (i64)(n - at));
    if (r == -EINTR) continue;
    if (r <= 0) leave(1);
    at += (u64)r;
  }
}
/* The walk goes on as several processes: this one returns in each of them (to search the file it was at, or not,
 * by its turn), and in the one that began it orders their output until they are done, and ends as one would. */
static void wide(void) {
  flush();
  u32 n = g.most;
  int from[64], pid[64];
  i64 m = sys6(SYS_mmap, 0, sizeof *shared, 3 /* read, write */, 0x21 /* shared, of no file */, -1, 0);
  if (m < 0 && m > -4096) { grep_threads(&g, 1, 1); return; }
  shared = (void *)m;
  for (u32 k = 0; k < n; k++) {
    int ends[2];
    if (sys2(SYS_pipe2, (i64)ends, O_CLOEXEC) < 0) { n = k; break; }
    sys3(SYS_fcntl, ends[1], 1031 /* F_SETPIPE_SZ */, 1 << 20);
    i64 child = sys1(SYS_fork, 0);
    if (child < 0) { sys1(SYS_close, ends[0]), sys1(SYS_close, ends[1]); n = k; break; }
    if (!child) {
      for (u32 j = 0; j < k; j++) sys1(SYS_close, from[j]);
      sys1(SYS_close, ends[0]);
      kids = n, me = k, turn = 0, wide_fd = ends[1];
      found = errors = 0, searched = 0;
      return; /* (a long text within its turn it still searches by threads: the others are as often waiting as not) */
    }
    sys1(SYS_close, ends[1]);
    from[k] = ends[0], pid[k] = (int)child;
  }
  if (!n) return; /* (no process could be made: this one goes on alone) */
  /* (Those made before one that could not be: they were told `n` as it was to be. Ended, and the walk goes on alone.) */
  if (n < g.most) {
    for (u32 k = 0; k < n; k++) sys2(SYS_kill, pid[k], 9), sys4(SYS_wait4, pid[k], 0, 0, 0);
    grep_threads(&g, 1, 1);
    return;
  }
  static u8 *room;
  enum { ROOM = 256 << 10 };
  if (!room) room = grab(ROOM);
  int printed = printed_any, ctx = last_ctx_file, early = -1, spliced = 1, gone = 0, reaped = 0;
  for (u64 i = 0; early < 0; i++) {
    /* Whose turn i was: known once one of them has taken it; none, where the walk had no such turn. */
    u32 at;
    if (i >= TURNS) at = (u32)(i % n);
    else {
      u32 who;
      while (!(who = __atomic_load_n(&shared->taker[i], __ATOMIC_ACQUIRE))) {
        u32 total = __atomic_load_n(&shared->total, __ATOMIC_ACQUIRE);
        if (total && i >= total - 1) break;
        struct { i64 s, ns; } soon = {0, 2000000}; /* (asked again in 2 ms at most: one may have ended without a word) */
        sys4(SYS_futex, (i64)&shared->taker[i], 0 /* FUTEX_WAIT */, 0, (i64)&soon);
        for (u32 k = 0; k < n && early < 0; k++) {
          int st = 0;
          if (pid[k] <= 0 || sys4(SYS_wait4, pid[k], (i64)&st, 1 /* WNOHANG */, 0) != pid[k]) continue;
          /* Ended: badly, or before any had come to the walk's end (-q and a match): the search ends as it did. */
          if (st & 0x7f || (st >> 8) & 0xff || !__atomic_load_n(&shared->total, __ATOMIC_ACQUIRE)) early = (int)k, gone = st, reaped = 1;
          else pid[k] = 0; /* (as it should, and waited for) */
        }
      }
      if (!who) break;
      at = who - 1;
    }
    if (early >= 0) break;
    for (int ended = 0; !ended && early < 0;) {
      u32 word;
      if (!wide_read(from[at], &word, 4)) { early = (int)at; break; } /* (it ended without saying it was done) */
      u32 kind = word & F_KIND, len = word & ~F_KIND;
      if (kind == F_DATA) {
        /* Moved from its pipe to standard output by the kernel, where it will (splice: nothing is copied out to here
         * and back); else read and written. */
        for (u64 left = len; left;) {
          i64 moved = spliced ? sys6(SYS_splice, from[at], 0, 1, 0, (i64)left, 0) : -EINVAL;
          if (moved == -EINTR) continue;
          if (moved > 0) { left -= (u64)moved; continue; }
          if (moved == 0) { early = (int)at; break; }
          spliced = 0;
          u64 take = left < ROOM ? left : ROOM;
          if (!wide_read(from[at], room, take)) { early = (int)at; break; }
          wide_out(room, take);
          left -= take;
        }
      } else if (kind == F_HEAD) {
        if (printed) wide_out("\n", 1);
      } else if (kind == F_SEP) {
        if (ctx && !o.no_ctx_sep) { const char *c = o.ctx_sep ? o.ctx_sep : "--"; wide_out(c, slen(c)); wide_out("\n", 1); }
        ctx = 0;
      } else if (kind == F_END) {
        printed |= (int)(len & 1);
        if (len & 2) ctx = 1;
        ended = 1;
      } else early = (int)at; /* (done, in the middle of a turn: not as it should end) */
    }
  }
  /* Every turn given out: what each found, said as it ended. */
  for (u32 k = 0; k < n && early < 0; k++) {
    struct __attribute__((packed)) { u32 word, found, errors, pad; u64 searched; } said;
    if (!wide_read(from[k], &said, sizeof said) || (said.word & F_KIND) != F_DONE) { early = (int)k; break; }
    found |= (int)said.found, errors |= (int)said.errors, searched += said.searched;
  }
  int status = gone;
  if (early >= 0) {
    /* One ended of itself (-q and a match: 0; out of room: 1): as it ended, so does the search, the rest with it. */
    for (u32 k = 0; k < n; k++) if ((int)k != early && pid[k] > 0) sys2(SYS_kill, pid[k], 9);
    if (!reaped) sys4(SYS_wait4, pid[early], (i64)&status, 0, 0);
    for (u32 k = 0; k < n; k++) if ((int)k != early && pid[k] > 0) sys4(SYS_wait4, pid[k], 0, 0, 0);
    leave(status & 0x7f ? 1 : (status >> 8) & 0xff);
  }
  for (u32 k = 0; k < n; k++) if (pid[k] > 0) sys4(SYS_wait4, pid[k], 0, 0, 0);
  leave(errors && !(o.quiet && found) ? 2 : !found);
}
