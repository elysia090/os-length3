/* ---- Backwards: every edge turned around (a byte's, an empty one's, an assertion's, the assertion mirrored: ^ for $,
 * \A for \z), begun at the match and matching where the pattern begins. Run from where a match ends, it finds where
 * the match begins: the furthest back it reaches (the leftmost start is the leftmost that ends there). State v's
 * reverse is v, a jump to its edges (a SPLIT chain over them); the match is state n. */
static struct re *re_reverse(struct re *f) {
  if (f->rev) return f->rev;
  struct re *r = (struct re *)grab(sizeof *r);
  *r = *f;
  r->rev = 0, r->lit = 0, r->litn = 0, r->only_lit = 0, r->lit_first = 0, r->nfirst = 0;
  u32 n = f->n, *cnt = (u32 *)grab(4 * ((u64)n + 1)), *first = (u32 *)grab(4 * ((u64)n + 1));
  memset(cnt, 0, 4 * ((u64)n + 1));
  for (u32 u = 0; u < n; u++) {
    struct rstate *s = &f->st[u];
    if (s->op == S_MATCH) continue;
    cnt[s->out]++;
    if (s->op == S_SPLIT) cnt[s->out1]++;
  }
  cnt[f->start]++; /* the start's way to the match */
  u32 *pred = (u32 *)grab(4 * ((u64)n * 2 + 2)), at = 0;
  for (u32 v = 0; v < n; v++) first[v] = at, at += cnt[v], cnt[v] = 0;
  for (u32 u = 0; u < n; u++) {
    struct rstate *s = &f->st[u];
    if (s->op == S_MATCH) continue;
    pred[first[s->out] + cnt[s->out]++] = u;
    if (s->op == S_SPLIT) pred[first[s->out1] + cnt[s->out1]++] = u;
  }
  pred[first[f->start] + cnt[f->start]++] = n;
  R = r;
  r->cap = n + 2 * at + 8, r->n = n + 1, r->st = (struct rstate *)grab(sizeof *r->st * r->cap);
  r->st[n] = (struct rstate){S_MATCH, 0, 0, 0, 0};
  u64 none[4] = {0};
  u16 empty = set_of(none);
  u32 mstate = 0;
  for (u32 v = 0; v < n; v++) {
    u32 head = ~0u;
    for (u32 k = 0; k < cnt[v]; k++) {
      u32 u = pred[first[v] + k], e;
      if (u == n) e = state(S_JUMP, 0, 0, n, 0);
      else {
        struct rstate *s = &f->st[u];
        if (s->op == S_SET) e = state(S_SET, 0, s->set, u, 0);
        else if (s->op == S_ASSERT) {
          u8 a = s->a == A_BOL ? A_EOL : s->a == A_EOL ? A_BOL : s->a == A_BOT ? A_EOT : s->a == A_EOT ? A_BOT : s->a;
          e = state(S_ASSERT, a, 0, u, 0);
        } else e = state(S_JUMP, 0, 0, u, 0);
      }
      head = head == ~0u ? e : state(S_SPLIT, 0, 0, e, head);
    }
    r->st[v] = head == ~0u ? (struct rstate){S_SET, 0, empty, 0, 0} : (struct rstate){S_JUMP, 0, 0, head, 0};
    if (f->st[v].op == S_MATCH) mstate = v;
  }
  r->start = mstate;
  f->rev = r;
  return r;
}
