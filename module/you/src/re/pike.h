/* The Pike machine's lists: the states live now, each once, in the order of their priority (sparse sets), and its
 * stack. Each DFA has its own (dfa.h), so threads each with their own DFAs run it at once. */
struct pike { u32 *dense[2], *sparse[2], n[2]; u64 *from[2]; u32 cap; u32 *stack; };
static int pk_has(struct pike *pk, int l, u32 s) { u32 k = pk->sparse[l][s]; return k < pk->n[l] && pk->dense[l][k] == s; }

/* Follow the empty edges from `s` at position i into list l, in priority order (a stack, out before out1). */
static void pk_add(struct pike *pk, struct re *r, int l, u32 s0, u64 from, const u8 *t, u64 n, u64 i) {
  u32 top = 0;
  pk->stack[top++] = s0;
  while (top) {
    u32 s = pk->stack[--top];
    if (pk_has(pk, l, s)) continue;
    pk->sparse[l][s] = pk->n[l];
    pk->dense[l][pk->n[l]] = s;
    pk->from[l][pk->n[l]++] = from;
    struct rstate *st = &r->st[s];
    if (st->op == S_JUMP || st->op == S_SAVE) pk->stack[top++] = st->out;
    else if (st->op == S_SPLIT) pk->stack[top++] = st->out1, pk->stack[top++] = st->out;
    else if (st->op == S_ASSERT && holds(st->a, t, n, i)) pk->stack[top++] = st->out;
  }
}

/* The leftmost-first match in t[from..n): 1, and where it is. Each step: a new start (lower in priority than every
 * thread before it) until a match is found; each thread, in priority order, matched (then those after it are cut off:
 * they rank below it) or taken over the byte. A thread ranked above the match goes on and may end a longer match,
 * which then stands, as leftmost-first has it. */
static int re_run(struct pike *pk, struct re *r, const u8 *t, u64 n, u64 from, u64 *ms, u64 *me) {
  if (pk->cap < r->n) {
    pk->cap = r->n;
    for (int l = 0; l < 2; l++) {
      pk->dense[l] = (u32 *)grab(4 * (u64)pk->cap), pk->sparse[l] = (u32 *)grab(4 * (u64)pk->cap);
      pk->from[l] = (u64 *)grab(8 * (u64)pk->cap);
    }
    pk->stack = (u32 *)grab(4 * (u64)pk->cap * 2 + 8);
  }
  int cur = 0, found = 0;
  pk->n[0] = 0;
  for (u64 i = from;; i++) {
    if (!found) pk_add(pk, r, cur, r->start, i, t, n, i);
    if (!pk->n[cur]) break;
    int nx = cur ^ 1;
    pk->n[nx] = 0;
    for (u32 k = 0; k < pk->n[cur]; k++) {
      struct rstate *st = &r->st[pk->dense[cur][k]];
      if (st->op == S_MATCH) { *ms = pk->from[cur][k], *me = i, found = 1; break; }
      if (st->op == S_SET && i < n && set_has(r->sets + 4 * st->set, t[i])) pk_add(pk, r, nx, st->out, pk->from[cur][k], t, n, i + 1);
    }
    if (i >= n) break;
    cur = nx;
  }
  return found;
}

/* ---- The groups of a match (RE_CAPTURE): where each begins and ends. A Pike machine whose threads each carry their
 * own (cap[2k], cap[2k+1]: group k's; 0 the whole), begun only at the match's start: the thread the leftmost-first
 * order ranks first gives them, as Rust's crate gives them. */
struct caps { u32 *dense[2], *sparse[2], n[2], cap, ncap; u64 *at[2]; };
static void cap_add(struct caps *c, struct re *r, int l, u32 s, u64 *cap, const u8 *t, u64 n, u64 i) {
  u32 k = c->sparse[l][s];
  if (k < c->n[l] && c->dense[l][k] == s) return;
  k = c->n[l]++;
  c->sparse[l][s] = k, c->dense[l][k] = s;
  struct rstate *st = &r->st[s];
  switch (st->op) {
    case S_JUMP: cap_add(c, r, l, st->out, cap, t, n, i); return;
    case S_SPLIT: cap_add(c, r, l, st->out, cap, t, n, i); cap_add(c, r, l, st->out1, cap, t, n, i); return;
    case S_ASSERT: if (holds(st->a, t, n, i)) cap_add(c, r, l, st->out, cap, t, n, i); return;
    case S_SAVE: {
      u64 was = cap[st->a];
      cap[st->a] = i;
      cap_add(c, r, l, st->out, cap, t, n, i);
      cap[st->a] = was;
      return;
    }
    default: memcpy(c->at[l] + (u64)k * c->ncap, cap, 8 * (u64)c->ncap); /* a byte's state, or the match */
  }
}
/* The groups of the leftmost-first match that begins at `ms` in t[0..n): 1 and cap (2 a group, ~0 where a group took
 * no part), or 0 for none there. */
static int re_captures(struct re *r, const u8 *t, u64 n, u64 ms, u64 *cap) {
  static struct caps c;
  u32 ncap = 2 * (r->groups < 127 ? r->groups + 1 : 128);
  if (c.cap < r->n || c.ncap < ncap) {
    c.cap = r->n, c.ncap = ncap;
    for (int l = 0; l < 2; l++) {
      c.dense[l] = (u32 *)grab(4 * (u64)c.cap), c.sparse[l] = (u32 *)grab(4 * (u64)c.cap);
      c.at[l] = (u64 *)grab(8 * (u64)c.cap * ncap);
    }
  }
  c.ncap = ncap;
  u64 start[256];
  for (u32 k = 0; k < ncap; k++) start[k] = ~0ull;
  int cur = 0, found = 0;
  c.n[0] = 0;
  cap_add(&c, r, 0, r->start, start, t, n, ms);
  for (u64 i = ms; c.n[cur]; i++) {
    int nx = cur ^ 1;
    c.n[nx] = 0;
    for (u32 k = 0; k < c.n[cur]; k++) {
      struct rstate *st = &r->st[c.dense[cur][k]];
      u64 *th = c.at[cur] + (u64)k * ncap;
      if (st->op == S_MATCH) { memcpy(cap, th, 8 * (u64)ncap); cap[0] = ms, cap[1] = i, found = 1; break; }
      if (st->op == S_SET && i < n && set_has(r->sets + 4 * st->set, t[i])) cap_add(&c, r, nx, st->out, th, t, n, i + 1);
    }
    if (i >= n) break;
    cur = nx;
  }
  return found;
}
