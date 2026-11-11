/*
 * A text searched as rg searches it: the lines that hold a match, in order, and each match on a line. Which way the
 * lines are found is the pattern's:
 *   - a literal and nothing more: found by the literal (lit_find: where its two rarest bytes both are, 64 or 128 places
 *     at a time, two others taken where the text has those two together often), each place its line;
 *   - one that begins with a literal: the literal's places, each asked of the DFA anchored there (dfa_at: a few bytes,
 *     not the line);
 *   - one with no literal of three bytes, whose matches all begin with bytes rare in text (re firsts: [A-Z]{3,}, \d{4},
 *     (foo|bar)): the places that begin so (cls_find: each first byte's ranges tested 32 or 64 places at a time), each
 *     asked of the DFA anchored there, until too many come to nothing, when the lanes are cheaper;
 *   - one that holds a literal: the literal's places, each line asked of the DFA (dfa_line) — until those lines are
 *     a quarter of what is passed over, when the lanes are cheaper;
 *   - else the DFA's four lanes over the whole text (dfa_lanes), a block at a time.
 * A match's place: where it ends by the forward DFA, where it begins by the reverse one; the Pike machine where
 * either cannot say (a \b beside a character past ASCII). One way for every text: rg's (ripgrep/rg.c), one thread.
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
  u64 cands;           /* places those found, to give them up for the lanes where too many come to nothing */
  int spans;           /* the caller asks each line for its matches (grep_span): a line the literal finds is not asked
                        * of the DFA first, the first grep_span is that question (one pass over it, not two) */
  u64 passed, verified, tried;
  struct pair pair;    /* the literal's two places it is looked for by, as this search's texts have them (lit_find) */
};

static void grep_init(struct grep *g, struct re *r) {
  static int asked;
  if (!asked) asked = 1, avx2_ask();
  memset(g, 0, sizeof *g);
  g->r = r;
  pair_init(&g->pair, r);
  /* (A literal of three or more is found faster than what a match begins with is: its first and last bytes.) */
  g->firsts = !r->only_lit && !r->lit_first && r->nfirst && r->litn < 3;
  if (!r->only_lit) g->lines = dfa_new(r, D_LINES);
  if (!r->only_lit && (r->lit_first || g->firsts)) g->at_dfa = dfa_new(r, D_ANCH);
}
/* The text searched goes on to n (a read more of it, rg.c: what was searched stays as it is). */
static void grep_upto(struct grep *g, u64 n) { g->n = n; }
static void grep_text(struct grep *g, const u8 *t, u64 n) {
  g->t = t, g->n = n, g->at = 0, g->nfound = g->took = 0, g->cands = 0;
  g->lanes = !g->r->litn && !g->firsts, g->passed = g->verified = g->tried = 0;
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
  while (g->at < n) {
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
    u64 p = g->firsts ? cls_find(r, t, n, g->at) : lit_find(t, n, g->at, r->lit, r->litn, r->icase, &g->pair);
    if (p == n) { g->at = n; break; }
    int k = 1, first = r->lit_first || g->firsts;
    /* Too many places that come to nothing (one in every 16 bytes, past the first 256): the lanes from here. */
    /* (From the start of the line it is in: places before it on its line came to nothing, but the lanes ask of lines.) */
    if (g->firsts && ++g->cands > 256 && (p + 1) < 16 * g->cands) {
      g->lanes = 1, g->nfound = g->took = 0, g->at = line_start(t, 0, g->at);
      continue;
    }
    if (!r->only_lit && first && (k = dfa_at(g->at_dfa, t, n, p)) == 0) { g->at = p + 1; continue; } /* none begins here */
    u64 ls = line_start(t, 0, p), le = line_end(t, n, p + (g->firsts ? 0 : r->litn)), ms, me;
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
