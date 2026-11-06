/*
 * A text searched as rg searches it: the lines that hold a match, in order, and each match on a line. Which way the
 * lines are found is the pattern's:
 *   - a literal and nothing more: found by the literal (lit_find, sixteen places at a time), each place its line;
 *   - one that holds a literal: the literal's places, each line asked of the DFA (dfa_line) — until those lines are
 *     a quarter of what is passed over, when the lanes are cheaper;
 *   - else the DFA's four lanes over the whole text (dfa_lanes), a block at a time.
 * A match's place: where it ends by the forward DFA, where it begins by the reverse one; the Pike machine where
 * either cannot say (a \b beside a character past ASCII).
 */

#define GREP_BLOCK (1u << 16)

struct grep {
  struct re *r;
  struct dfa *lines, *fwd, *rev;
  const u8 *t;
  u64 n, at;
  u64 *found, cap;
  u32 nfound, took;
  int lanes;           /* the literal let go of: the lanes from here */
  u64 passed, verified, tried;
};

static void grep_init(struct grep *g, struct re *r) {
  memset(g, 0, sizeof *g);
  g->r = r;
  if (!r->only_lit) g->lines = dfa_new(r, D_LINES);
}
static void grep_text(struct grep *g, const u8 *t, u64 n) {
  g->t = t, g->n = n, g->at = 0, g->nfound = g->took = 0;
  g->lanes = !g->r->litn, g->passed = g->verified = g->tried = 0;
}

/* The start of the next line that holds a match, or n when there is none. */
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
    u64 p = lit_find(t, n, g->at, r->lit, r->litn, r->icase);
    if (p == n) { g->at = n; break; }
    u64 ls = line_start(t, g->at, p), le = line_end(t, n, p + r->litn);
    g->passed += le + 1 - g->at;
    g->at = le < n ? le + 1 : n;
    if (r->only_lit) return ls;
    g->verified += le - ls, g->tried++;
    int k = dfa_line(g->lines, t, ls, le);
    u64 ms, me;
    if (k > 0 || (k < 0 && re_run(r, t + ls, le - ls, 0, &ms, &me))) return ls;
    if (g->tried >= 32 && g->verified * 4 > g->passed) g->lanes = 1, g->nfound = g->took = 0;
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
      s = lit_find(t, n, from, r->lit, r->litn, r->icase);
      if (s == n) return 0;
      e = s + r->litn;
    } else {
      if (!g->fwd) g->fwd = dfa_new(r, D_FWD), g->rev = dfa_new(re_reverse(r), D_REV);
      i64 end = dfa_fwd(g->fwd, t, 0, n, from), start = end >= 0 ? dfa_rev(g->rev, t, 0, n, from, (u64)end) : end;
      if (end == -1) return 0;
      if (start < 0) { /* the DFA cannot say: the Pike machine */
        if (!re_run(r, t, n, from, &s, &e)) return 0;
      } else s = (u64)start, e = (u64)end;
    }
    if (s == e && ls + e == *last) { from = e + 1; continue; }
    *ms = ls + s, *me = *x = *last = ls + e;
    return 1;
  }
  return 0;
}
