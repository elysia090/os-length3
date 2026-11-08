/*
 * A text searched in pieces by as many threads as there are cores, each piece by grep.c's search: what a unit that
 * searches one large text includes after grep.c (rg searches with one thread; you/test/regex-driver.c with these).
 */

/* The text in pieces, searched by as many threads as the process has cores: the text cut at line ends into eight
 * pieces a thread (each GREP_PIECE long at least: a thread costs more than a smaller one is worth), each thread taking
 * the next piece not yet taken as it is done with one (so one with more to say, or a slower core, holds no other up),
 * with DFAs of its own; what each piece found (each line that holds a match, or each match: spans) put as it is said,
 * the pieces said in order once all are done. */
#define GREP_PIECE (512u << 10)
#define GREP_THREADS 16
#define GREP_STACK (256u << 10)
struct piece {
  const u8 *t;
  u64 n;               /* the piece: t[0..n) */
  u8 *out;             /* what it found, as it is said: each line (or each match) and a line feed */
  u64 outn, outcap;
};
struct pieces {
  struct piece *p;
  u32 n, next;         /* next: the first not yet taken (taken at once, an atomic add) */
  int spans, populate; /* populate: the text is a file's pages mapped, not yet read in */
};
struct searcher { struct grep g; struct pieces *all; int left; };

/* t[a..b) and a line feed, at the end of what the piece says (made larger, twice as large, when it is full). */
static void piece_keep(struct piece *p, const u8 *t, u64 a, u64 b) {
  u64 n = b - a + 1;
  if (p->outn + n > p->outcap) {
    u64 cap = p->outcap ? 2 * p->outcap : 1u << 16;
    while (cap < p->outn + n) cap *= 2;
    u8 *m = grab(cap);
    if (p->outn) memcpy(m, p->out, p->outn);
    p->out = m, p->outcap = cap;
  }
  memcpy(p->out + p->outn, t + a, n - 1);
  p->out[p->outn + n - 1] = '\n';
  p->outn += n;
}

static void search(void *arg) {
  struct searcher *w = arg;
  struct pieces *all = w->all;
  for (u32 i; (i = __atomic_fetch_add(&all->next, 1, __ATOMIC_RELAXED)) < all->n;) {
    struct piece *p = &all->p[i];
    const u8 *t = p->t;
    u64 n = p->n;
    /* Its pages read in at once (MADV_POPULATE_READ; a kernel without it: as each is first touched), each thread its
     * own pieces', side by side. */
    if (all->populate && n) {
      u64 a = (u64)t & ~4095ul;
      sys3(SYS_madvise, (i64)a, (i64)((u64)t + n - a), 22);
    }
    grep_text(&w->g, t, n);
    for (u64 ls; (ls = grep_line(&w->g)) < n;) {
      u64 le = line_end(t, n, ls);
      if (!all->spans) { piece_keep(p, t, ls, le); continue; }
      for (u64 x = ls, last = ~0ull, ms, me; grep_span(&w->g, ls, le, &x, &last, &ms, &me);) piece_keep(p, t, ms, me);
    }
  }
}

/* t[0..n) searched in pieces: what each says, in the text's order piece after piece (all->p[0..all->n)). `populate`:
 * the text is a file's pages mapped and not yet read in. */
static struct pieces *grep_all(struct re *r, const u8 *t, u64 n, int spans, int populate) {
  u32 k = cores();
  if (k > GREP_THREADS) k = GREP_THREADS;
  u64 np = n / GREP_PIECE;
  if (np > 8 * (u64)k) np = 8 * (u64)k;
  if (!np) np = 1;
  if (k > np) k = (u32)np;
  /* What a thread would make the first time it is asked, made here first: nothing shared is made by two at once. */
  re_classes(r);
  if (spans && !r->only_lit) re_classes(re_reverse(r));
  struct pieces *all = (struct pieces *)grab(sizeof *all);
  all->p = (struct piece *)grab(sizeof *all->p * np);
  memset(all->p, 0, sizeof *all->p * np);
  all->n = (u32)np, all->next = 0, all->spans = spans, all->populate = populate;
  for (u64 i = 0, from = 0; i < np; i++) {
    u64 to = i + 1 == np ? n : line_end(t, n, n / np * (i + 1));
    if (to < n) to++;
    if (to < from) to = from;
    all->p[i].t = t + from, all->p[i].n = to - from;
    from = to;
  }
  struct searcher *w = (struct searcher *)grab(sizeof *w * k);
  for (u32 i = 0; i < k; i++) grep_init(&w[i].g, r), w[i].g.spans = spans, w[i].all = all, w[i].left = 0;
  for (u32 i = 1; i < k; i++) spawn(search, &w[i], grab(GREP_STACK), GREP_STACK, &w[i].left); /* (none: this one) */
  search(&w[0]);
  for (u32 i = 1; i < k; i++) join(&w[i].left);
  return all;
}
