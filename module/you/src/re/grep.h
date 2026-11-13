/*
 * A text searched as rg searches it: the lines that hold a match, in order, and each match on a line. Which way the
 * lines are found is the pattern's:
 *   - a literal and nothing more: found by the literal (lit_find: where its two rarest bytes both are, 64 or 128 places
 *     at a time, two others taken where the text has those two together often), each place its line;
 *   - one that begins with a literal: the literal's places, each asked of the DFA anchored there (dfa_at: a few bytes,
 *     not the line);
 *   - one whose matches all begin with one of a few literals (re prefixes: foo|bar|baz, (get|set)_\w+): the places
 *     where two bytes of one of them are (any_find: 64 places at a time), each asked of the DFA anchored there;
 *   - one with no literal of three bytes, whose matches all begin with bytes rare in text (re firsts: [A-Z]{3,}, \d{4},
 *     (foo|bar)): the places that begin so (cls_find: each first byte's ranges tested 32 or 64 places at a time), each
 *     asked of the DFA anchored there, until too many come to nothing, when the lanes are cheaper;
 *   - one that holds a literal: the literal's places, each line asked of the DFA (dfa_line) — until those lines are
 *     a quarter of what is passed over, when the lanes are cheaper;
 *   - else the DFA's four lanes over the whole text (dfa_lanes), a block at a time.
 * A match's place: where it ends by the forward DFA, where it begins by the reverse one; the Pike machine where
 * either cannot say (a \b beside a character past ASCII). One way for every text: rg's (../rg.c), one thread.
 */

#define GREP_BLOCK (1u << 16)

struct grep {
  struct re *r;
  struct dfa *lines, *fwd, *rev, *at_dfa; /* at_dfa: anchored, forwards (a pattern that begins with its literal) */
  const u8 *t;
  u64 n, at;
  u64 *found, cap;
  u32 nfound, took;
  int lanes;           /* the literal let go of: the lanes from here */
  int firsts;          /* the places found by what matches begin with (re firsts: cls_find), not by a literal */
  int pre;             /* or by the few literals every match begins with one of (re prefixes: any_find) */
  struct any any;
  u64 cands, began;    /* places those found since the search began (at `began`), to give them up for the lanes where
                        * too many come to nothing */
  int spans;           /* the caller asks each line for its matches (grep_span): a line the literal finds is not asked
                        * of the DFA first, the first grep_span is that question (one pass over it, not two) */
  u64 passed, verified, tried;
  struct pair pair;    /* the literal's two places it is looked for by, as this search's texts have them (lit_find) */
  /* More threads than one (below): the whole text's length, how many threads a window is run by and how many at
   * most, whether that count is settled, and the window: its pieces, the next no thread has taken, which of them
   * and of its lines is given next, its end. */
  u64 all, wend;
  u32 threads, most, settled, pieces, pnext, pat, ptook;
  u64 rate; /* the last window's bytes a millisecond, by `threads` */
  int ahead;
  struct hand *hand;
  struct piece *piece;
};

/* ---- More threads than one. A text past its first megabyte is searched a window at a time: the window cut at line
 * ends into pieces of a megabyte, eight a thread, each thread taking the next piece as it is done with one, with a
 * search of its own (its own DFAs, its own places a literal is looked for by) and reading in the pages of the piece
 * it takes (the kernel fills a piece's page table on the thread that will read it, the threads side by side). What
 * comes of it is each piece's lines that hold a match, in the order of the text; what asks for lines (grep_line) is
 * given them one at a time as it was by one thread, so what is printed is the same, byte for byte, however many
 * threads found it. A search that ends in its first megabyte (-m, -l, -q, a small file) starts none.
 *
 * How many threads: as many as go faster. The first window is run by as many as the cores this process may run on
 * (eight at most). Where the text is long enough for the asking to cost nothing that shows (sixteen windows and
 * more to go), the next is run by half as many: if that searched five sixths as many bytes in a millisecond, the
 * half is kept and halved again; if not, the count before is kept, for this text and those after it. A text that
 * comes from memory no faster by four threads than by two (a literal seldom there) is then read by two, and the
 * other cores left cold; one the automaton reads byte by byte keeps them all. -j N says the count itself.
 *
 * What it holds is bounded: a piece's lines are 65536 at most (past them the piece ends there, and the window with
 * it), so a pattern with much to say takes no more room than one with little. */
#define AHEAD_AFTER (1u << 20)
#define AHEAD_PIECE (1u << 20)
#define AHEAD_LINES (1u << 16)
#define AHEAD_STACK (1u << 20)
#define AHEAD_MOST 64 /* pieces a window */
struct piece { u64 from, to, done; u32 *line, n; };
struct hand { struct grep g; struct grep *of; int left; u8 *stack; };
static u64 grep_line(struct grep *g);
static void grep_text(struct grep *g, const u8 *t, u64 n);
static void grep_init(struct grep *g, struct re *r);
/* A thread's part of a window: the next piece no one has taken, until none is left. */
static void hand_run(void *arg) {
  struct hand *h = (struct hand *)arg;
  struct grep *of = h->of;
  for (u32 k; (k = __atomic_fetch_add(&of->pnext, 1, __ATOMIC_RELAXED)) < of->pieces;) {
    struct piece *p = &of->piece[k];
    /* Its pages, read in here: whole pages from the one its first byte is in. */
    u64 page = (u64)(of->t + p->from) & ~4095ull;
    sys3(SYS_madvise, (i64)page, (i64)((u64)(of->t + p->to) - page), 22 /* MADV_POPULATE_READ */);
    grep_text(&h->g, of->t, p->to);
    h->g.at = h->g.began = p->from;
    u32 n = 0;
    for (u64 ls; n < AHEAD_LINES && (ls = grep_line(&h->g)) < p->to;) p->line[n++] = (u32)(ls - p->from);
    p->n = n;
    p->done = n < AHEAD_LINES ? p->to : line_end(of->t, p->to, p->from + p->line[n - 1]) + 1;
  }
}
static u64 us_now(void) {
  struct { i64 s, ns; } ts;
  sys2(SYS_clock_gettime, 1 /* CLOCK_MONOTONIC */, (i64)&ts);
  return (u64)ts.s * 1000000ull + (u64)ts.ns / 1000;
}
/* The window from `from`: its pieces searched by `threads` threads, this one among them. */
static void grep_window(struct grep *g, u64 from) {
  const u8 *t = g->t;
  if (!g->hand) {
    g->hand = (struct hand *)grab(sizeof *g->hand * g->most), g->piece = (struct piece *)grab(sizeof *g->piece * AHEAD_MOST);
    memset(g->hand, 0, sizeof *g->hand * g->most), memset(g->piece, 0, sizeof *g->piece * AHEAD_MOST);
    (void)char_word(0x80); /* (a word's characters past ASCII, read into their table once, before any thread asks) */
  }
  u32 want = 8 * g->threads < AHEAD_MOST ? 8 * g->threads : AHEAD_MOST, n = 0;
  u64 a = from, began = us_now();
  for (; n < want && a < g->all; n++) {
    struct piece *p = &g->piece[n];
    if (!p->line) p->line = (u32 *)grab(4 * AHEAD_LINES);
    u64 b = g->all - a <= AHEAD_PIECE ? g->all : line_end(t, g->all, a + AHEAD_PIECE) + 1;
    if (b > g->all) b = g->all;
    p->from = a, p->to = b, p->n = 0, p->done = a;
    a = b;
  }
  g->pieces = n, g->pnext = 0, g->pat = g->ptook = 0, g->wend = a;
  u32 ran = g->threads < n ? g->threads : n;
  for (u32 k = 0; k < ran; k++) {
    struct hand *h = &g->hand[k];
    if (!h->of) { /* its search and (but for this thread's) its stack: made once, kept for every window */
      grep_init(&h->g, g->r);
      h->of = g;
      if (k) h->stack = grab(AHEAD_STACK);
    }
    h->left = k ? 1 : 0;
    if (k && spawn(hand_run, h, h->stack, AHEAD_STACK, &h->left) < 0) h->left = 0; /* (no thread: the rest take its pieces) */
  }
  hand_run(&g->hand[0]);
  for (u32 k = 1; k < ran; k++) join(&g->hand[k].left);
  /* (A piece that ended at its lines' limit: the window ends there, and what was found past it is not kept.) */
  for (u32 i = 0; i < n; i++)
    if (g->piece[i].done < g->piece[i].to) { g->pieces = i + 1, g->wend = g->piece[i].done; break; }
  /* How many threads the next is run by. */
  u64 took = us_now() - began, rate = (g->wend - from) * 1000 / (took ? took : 1);
  if (!g->settled && g->pieces == n && n == want) {
    if (g->rate && rate * 6 < g->rate * 5) g->threads *= 2, g->settled = 1; /* (the half was slower: back) */
    else if (g->threads >= 4 && g->all - g->wend >= 16 * (g->wend - from)) g->rate = rate, g->threads /= 2;
    else g->settled = 1;
  }
}
/* The next line that holds a match, from the windows; g->n when none is before it (what is searched ends there). */
static u64 grep_ahead(struct grep *g) {
  for (;;) {
    for (; g->pat < g->pieces; g->pat++, g->ptook = 0) {
      struct piece *p = &g->piece[g->pat];
      if (g->ptook == p->n) continue;
      u64 ls = p->from + p->line[g->ptook];
      if (ls >= g->n) return g->n; /* (found, and not yet within what is searched: grep_upto) */
      g->ptook++;
      return ls;
    }
    if (g->wend >= g->n) return g->n;
    grep_window(g, g->wend);
  }
}

static void grep_init(struct grep *g, struct re *r) {
  static int asked;
  if (!asked) asked = 1, avx2_ask();
  memset(g, 0, sizeof *g);
  g->r = r;
  pair_init(&g->pair, r);
  /* (A literal of three or more is found faster than what a match begins with is: its first and last bytes.) */
  /* (What a match begins with over a literal it holds further in, unless that literal is the longer by more than a
   * byte: a place a match begins at is asked there, a place it holds something at is asked of its whole line.) */
  g->pre = !r->only_lit && !r->lit_first && r->npre && (r->litn < 3 || (r->prelen >= 3 && r->litn <= r->prelen + 1));
  if (g->pre) any_init(&g->any, r);
  g->firsts = !g->pre && !r->only_lit && !r->lit_first && r->nfirst && r->litn < 3;
  if (!r->only_lit) g->lines = dfa_new(r, D_LINES);
  if (!r->only_lit && (r->lit_first || g->firsts || g->pre)) g->at_dfa = dfa_new(r, D_ANCH);
  g->most = 1;
}
/* As many threads as `most` at most, where a text is long enough (0: as many as this process's cores, eight at most);
 * `fixed`: that many, not as many as go faster. */
static void grep_threads(struct grep *g, u32 most, int fixed) {
  if (!most) most = cores() < 8 ? cores() : 8;
  if (most > 64) most = 64;
  g->most = most, g->threads = most, g->settled = fixed || most <= 2, g->rate = 0;
}
/* The text searched goes on to n (a read more of it, rg.c: what was searched stays as it is). */
static void grep_upto(struct grep *g, u64 n) { g->n = n; }
/* The whole text is n bytes, and may be searched ahead of what grep_upto has said (all of it is there to read). */
static void grep_all(struct grep *g, u64 n) { g->all = n; }
static void grep_text(struct grep *g, const u8 *t, u64 n) {
  g->t = t, g->n = n, g->at = g->began = 0, g->nfound = g->took = 0, g->cands = 0, g->all = n, g->ahead = 0;
  g->lanes = !g->pre && !g->firsts && !g->r->litn, g->passed = g->verified = g->tried = 0;
}

/* ---- The places where a match may begin, by what every match begins with (re firsts): each of the pattern's first
 * bytes tested against its ranges for 16 (32) places at once, the byte after against the second's, and so on; the
 * places all of them hold for. */
typedef unsigned char u8x16 __attribute__((vector_size(16)));
static inline u32 cls16(const struct re *r, u32 j, const u8 *p) {
  u8x16 v, in = {0};
  __builtin_memcpy(&v, p, 16);
  for (u32 k = 0; k < r->nrange[j]; k++)
    in |= (u8x16)((u8x16)(v - (u8)r->first[j][k][0]) <= (u8)(r->first[j][k][1] - r->first[j][k][0]));
  return (u32)__builtin_ia32_pmovmskb128((v16)in);
}
typedef unsigned char u8x32 __attribute__((vector_size(32)));
__attribute__((target("avx2"))) static inline u32 cls32(const struct re *r, u32 j, const u8 *p) {
  u8x32 v, in = {0};
  __builtin_memcpy(&v, p, 32);
  for (u32 k = 0; k < r->nrange[j]; k++)
    in |= (u8x32)((u8x32)(v - (u8)r->first[j][k][0]) <= (u8)(r->first[j][k][1] - r->first[j][k][0]));
  return (u32)__builtin_ia32_pmovmskb256((v32)in);
}
static inline int cls_at(const struct re *r, const u8 *t, u64 i) {
  for (u32 j = 0; j < r->nfirst; j++) {
    int in = 0;
    for (u32 k = 0; k < r->nrange[j]; k++) in |= (u8)(t[i + j] - r->first[j][k][0]) <= (u8)(r->first[j][k][1] - r->first[j][k][0]);
    if (!in) return 0;
  }
  return 1;
}
__attribute__((target("avx2"))) static u64 cls_find_avx2(const struct re *r, const u8 *t, u64 n, u64 i) {
  u32 k = r->nfirst;
  for (; i + 64 + k - 1 <= n; i += 64) {
    u64 m = ~0ull;
    for (u32 j = 0; j < k && m; j++) m &= (u64)cls32(r, j, t + i + j) | (u64)cls32(r, j, t + i + j + 32) << 32;
    if (m) return i + (u32)__builtin_ctzll(m);
  }
  for (; i + k <= n; i++) if (cls_at(r, t, i)) return i;
  return n;
}
static u64 cls_find(const struct re *r, const u8 *t, u64 n, u64 i) {
  if (avx2) return cls_find_avx2(r, t, n, i);
  u32 k = r->nfirst;
  for (; i + 32 + k - 1 <= n; i += 32) {
    u32 m = ~0u;
    for (u32 j = 0; j < k && m; j++) m &= cls16(r, j, t + i + j) | cls16(r, j, t + i + j + 16) << 16;
    if (m) return i + (u32)__builtin_ctz(m);
  }
  for (; i + k <= n; i++) if (cls_at(r, t, i)) return i;
  return n;
}

/* The start of the next line that holds a match, or n when there is none (with spans: a line that may hold one, which
 * then has none when its first grep_span finds none). */
static u64 grep_line(struct grep *g) {
  struct re *r = g->r;
  const u8 *t = g->t;
  u64 n = g->n;
  if (g->ahead) return grep_ahead(g);
  while (g->at < n) {
    /* Past its first megabyte, with as much again to go: the windows from here (more threads than one). */
    if (g->most > 1 && g->at >= AHEAD_AFTER && g->took >= g->nfound && g->all - g->at >= 4 * AHEAD_PIECE) {
      g->ahead = 1, g->wend = g->at, g->pieces = g->pat = 0;
      return grep_ahead(g);
    }
    if (g->lanes) {
      if (g->took < g->nfound) return g->found[g->took++];
      u64 to = g->at + GREP_BLOCK >= n ? n : line_end(t, n, g->at + GREP_BLOCK);
      if (to < n) to++;
      if (to - g->at > g->cap) { /* room for a line's start a byte of the block (one that ends a long line: more) */
        g->cap = to - g->at > 2 * (u64)GREP_BLOCK ? to - g->at : 2 * (u64)GREP_BLOCK;
        g->found = (u64 *)grab(8 * g->cap);
      }
      g->nfound = dfa_lanes(g->lines, t, n, g->at, to, g->found);
      g->took = 0, g->at = to;
      continue;
    }
    int begins = g->firsts || g->pre; /* the places are found by what a match begins with */
    u64 p = g->pre ? any_find(&g->any, r, t, n, g->at) : g->firsts ? cls_find(r, t, n, g->at) : lit_find(t, n, g->at, r->lit, r->litn, r->icase, &g->pair);
    if (p == n) { g->at = n; break; }
    int k = 1, first = r->lit_first || begins;
    /* Too many places that come to nothing (one in every 16 bytes, past the first 256): the lanes from here. */
    /* (From the start of the line it is in: places before it on its line came to nothing, but the lanes ask of lines.) */
    if (begins && ++g->cands > 256 && (p + 1 - g->began) < 16 * g->cands) {
      g->lanes = 1, g->nfound = g->took = 0, g->at = line_start(t, 0, g->at);
      continue;
    }
    if (!r->only_lit && first && (k = dfa_at(g->at_dfa, t, n, p)) == 0) { g->at = p + 1; continue; } /* none begins here */
    u64 ls = line_start(t, 0, p), le = line_end(t, n, p + (begins ? 0 : r->litn)), ms, me;
    if (!r->only_lit && (!first || k == 2)) {
      g->passed += le + 1 - g->at, g->verified += le - ls, g->tried++;
      if (g->tried >= 32 && g->verified * 4 > g->passed) g->lanes = 1, g->nfound = g->took = 0; /* (from the next) */
      if (g->spans) { g->at = le < n ? le + 1 : n; return ls; } /* (asked by its first grep_span) */
      k = dfa_line(g->lines, t, ls, le);
    }
    g->at = le < n ? le + 1 : n;
    if (k > 0 || (k < 0 && re_run(&g->lines->pk, r, t + ls, le - ls, 0, &ms, &me))) return ls;
  }
  if (g->took < g->nfound) return g->found[g->took++];
  return n;
}

/* The next match on the line t[ls..le) at *x or after it, as Rust's crate's find_iter has them: an empty match where
 * the last one ended (*last) passed over, a byte on. 1, and where it is (*x and *last then its end), or 0. */
static int grep_span(struct grep *g, u64 ls, u64 le, u64 *x, u64 *last, u64 *ms, u64 *me) {
  struct re *r = g->r;
  const u8 *t = g->t + ls;
  u64 n = le - ls;
  for (u64 from = *x - ls; from <= n;) {
    u64 s, e;
    if (r->only_lit) {
      s = lit_find(t, n, from, r->lit, r->litn, r->icase, &g->pair);
      if (s == n) return 0;
      e = s + r->litn;
    } else {
      if (!g->fwd) g->fwd = dfa_new(r, D_FWD), g->rev = dfa_new(re_reverse(r), D_ANCH);
      i64 end = dfa_fwd(g->fwd, t, 0, n, from), start = end >= 0 ? dfa_rev(g->rev, t, 0, n, from, (u64)end) : end;
      if (end == -1) return 0;
      if (start < 0) { /* the DFA cannot say: the Pike machine */
        if (!re_run(&g->fwd->pk, r, t, n, from, &s, &e)) return 0;
      } else s = (u64)start, e = (u64)end;
    }
    if (s == e && ls + e == *last) { from = e + 1; continue; }
    *ms = ls + s, *me = *x = *last = ls + e;
    return 1;
  }
  return 0;
}
