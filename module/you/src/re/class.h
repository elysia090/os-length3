/* ---- Unicode's tables (unicode.h): numbers seven bits a byte. */

static u32 varint(const u8 *t, u32 *i) {
  u32 v = 0;
  for (u32 shift = 0;; shift += 7) {
    u8 b = t[(*i)++];
    v |= (u32)(b & 0x7f) << shift;
    if (!(b & 0x80)) return v;
  }
}

/* ---- Classes: ranges of characters, gathered in any order, then sorted and joined (cls_norm). */

struct cls { u32 *r, n, cap; }; /* r[2i], r[2i+1]: a range, both ends in */

static void cls_init(struct cls *k) { k->cap = 16, k->n = 0, k->r = (u32 *)grab(8 * 16); }
static void cls_add(struct cls *k, u32 lo, u32 hi) {
  if (k->n == k->cap) {
    u32 *m = (u32 *)grab(8 * (u64)k->cap * 2);
    memcpy(m, k->r, 8 * (u64)k->n);
    k->r = m, k->cap *= 2;
  }
  k->r[2 * k->n] = lo, k->r[2 * k->n + 1] = hi, k->n++;
}
static void cls_norm(struct cls *k) {
  for (u32 i = 1; i < k->n; i++) { /* insertion sort: what is added comes mostly in order */
    u32 lo = k->r[2 * i], hi = k->r[2 * i + 1], j = i;
    for (; j && k->r[2 * j - 2] > lo; j--) k->r[2 * j] = k->r[2 * j - 2], k->r[2 * j + 1] = k->r[2 * j - 1];
    k->r[2 * j] = lo, k->r[2 * j + 1] = hi;
  }
  u32 m = 0;
  for (u32 i = 0; i < k->n; i++) {
    u32 lo = k->r[2 * i], hi = k->r[2 * i + 1];
    if (m && lo <= k->r[2 * m - 1] + 1) { if (hi > k->r[2 * m - 1]) k->r[2 * m - 1] = hi; }
    else k->r[2 * m] = lo, k->r[2 * m + 1] = hi, m++;
  }
  k->n = m;
}
/* Every character the class does not take (0 to 0x10ffff). */
static void cls_negate(struct cls *k) {
  cls_norm(k);
  u32 n = k->n, *r = k->r, next = 0;
  cls_init(k);
  for (u32 i = 0; i < n; i++) {
    if (r[2 * i] > next) cls_add(k, next, r[2 * i] - 1);
    next = r[2 * i + 1] + 1;
  }
  if (next <= 0x10ffff) cls_add(k, next, 0x10ffff);
}
/* A table's ranges past ASCII (unicode.h's U_WORD and the rest). */
static void cls_table(struct cls *k, const u8 *t, u32 len) {
  for (u32 i = 0, at = 0x7f; i < len;) {
    u32 lo = at + 1 + varint(t, &i), hi = lo + varint(t, &i);
    cls_add(k, lo, hi);
    at = hi;
  }
}
/* What is the same with case aside, added: each character's next in its circle of case, round the circle. */
static void cls_fold(struct cls *k) {
  for (int round = 1; round < U_FOLD_ROUND; round++) {
    cls_norm(k);
    u32 n = k->n;
    for (u32 i = 0, at = ~0u; i < sizeof U_FOLD;) {
      u32 start = at + 1 + varint(U_FOLD, &i), count = varint(U_FOLD, &i), kind = varint(U_FOLD, &i);
      u32 step = (kind & 3) == 1 ? 2 : 1, last = start + count * step, z = kind >> 2;
      i64 d = z & 1 ? -(i64)(z >> 1) - 1 : (i64)(z >> 1);
      at = last;
      for (u32 j = 0; j < n; j++) {
        u32 lo = k->r[2 * j] > start ? k->r[2 * j] : start, hi = k->r[2 * j + 1] < last ? k->r[2 * j + 1] : last;
        if (lo > hi) continue;
        switch (kind & 3) {
          case 0: cls_add(k, (u32)(lo + d), (u32)(hi + d)); break;
          case 1: for (u32 c = lo + ((lo - start) & 1); c <= hi; c += 2) cls_add(k, (u32)(c + d), (u32)(c + d)); break;
          case 2: cls_add(k, lo & ~1u, hi | 1u); break; /* 2k ↔ 2k+1 */
          default: cls_add(k, lo & 1 ? lo : lo - 1, hi & 1 ? hi + 1 : hi); /* 2k+1 ↔ 2k+2 */
        }
      }
    }
  }
  cls_norm(k);
}

/* ---- A class as bytes: its characters spelled in UTF-8, each range as sequences of byte ranges (split until each
 * piece is the same length and each of its bytes a range of its own), put in a trie; then, from the leaves up, like
 * branches made one, and a branch's bytes that go the same way made one set. Node 0 is the leaf, 1 the root. */

struct tedge { u8 lo, hi; u32 to, next; };
static struct tedge *te;
static u32 nte, cte, *tfirst, *tmade, ntn, ctn;

static u32 utf8_len(u32 c) { return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
static void utf8_put(u32 c, u8 *o) {
  u32 n = utf8_len(c);
  if (n == 1) { o[0] = (u8)c; return; }
  for (u32 i = n - 1; i > 0; i--) o[i] = (u8)(0x80 | (c & 0x3f)), c >>= 6;
  o[0] = (u8)((n == 2 ? 0xc0 : n == 3 ? 0xe0 : 0xf0) | c);
}
static u32 tnode(void) {
  if (ntn == ctn) {
    u32 *f = (u32 *)grab(4 * (u64)ctn * 2), *m = (u32 *)grab(4 * (u64)ctn * 2);
    memcpy(f, tfirst, 4 * (u64)ntn), memcpy(m, tmade, 4 * (u64)ntn);
    tfirst = f, tmade = m, ctn *= 2;
  }
  tfirst[ntn] = 0, tmade[ntn] = ~0u;
  return ntn++;
}
static void tinsert(u32 n, const u8 *lo, const u8 *hi) {
  u32 v = 1;
  for (u32 i = 0; i < n; i++) {
    u32 e = tfirst[v];
    while (e && !(te[e].lo == lo[i] && te[e].hi == hi[i])) e = te[e].next;
    if (!e) {
      if (nte == cte) {
        struct tedge *m = (struct tedge *)grab(sizeof *m * cte * 2);
        memcpy(m, te, sizeof *m * nte);
        te = m, cte *= 2;
      }
      u32 to = i + 1 < n ? tnode() : 0;
      e = nte++;
      te[e] = (struct tedge){lo[i], hi[i], to, tfirst[v]};
      tfirst[v] = e;
    }
    v = te[e].to;
  }
}
static void tseqs(u32 lo, u32 hi) {
  if (lo > hi) return;
  if (lo <= 0xdfff && hi >= 0xd800) { /* no surrogates: they are not characters */
    if (lo < 0xd800) tseqs(lo, 0xd7ff);
    if (hi > 0xdfff) tseqs(0xe000, hi);
    return;
  }
  if (utf8_len(lo) != utf8_len(hi)) {
    u32 edge = utf8_len(lo) == 1 ? 0x7f : utf8_len(lo) == 2 ? 0x7ff : 0xffff;
    tseqs(lo, edge), tseqs(edge + 1, hi);
    return;
  }
  u32 n = utf8_len(lo);
  for (u32 i = 1; i < n; i++) {
    u32 m = (1u << (6 * i)) - 1;
    if ((lo & ~m) != (hi & ~m)) {
      if (lo & m) { tseqs(lo, lo | m), tseqs((lo | m) + 1, hi); return; }
      if ((hi & m) != m) { tseqs(lo, (hi & ~m) - 1), tseqs(hi & ~m, hi); return; }
    }
  }
  u8 a[4], b[4];
  utf8_put(lo, a), utf8_put(hi, b);
  tinsert(n, a, b);
}
/* The branches made so far, each as its edges (range, and the state its branch begins at), to find a like one by. */
static u32 *tsig, ntsig, ctsig, *tmadeat, *tmadelen, *tmadestate, ntmade, ctmade;
static u32 thole;
/* The state the branch at node v begins at (made, or found made): its edges' sets, each a SET to where they go,
 * chained by SPLITs. */
static u32 temit(u32 v) {
  if (!v) return ~0u; /* the leaf: the class's end, a hole */
  if (tmade[v] != ~0u) return tmade[v];
  for (u32 e = tfirst[v]; e; e = te[e].next) temit(te[e].to); /* the branches below first: their edges are read after */
  u32 at = ntsig, k = 0;
  for (u32 e = tfirst[v]; e; e = te[e].next, k++) {
    u32 to = temit(te[e].to);
    if (ntsig + 3 > ctsig) {
      u32 *m = (u32 *)grab(4 * (u64)ctsig * 2);
      memcpy(m, tsig, 4 * (u64)ntsig);
      tsig = m, ctsig *= 2;
    }
    tsig[ntsig++] = te[e].lo, tsig[ntsig++] = te[e].hi, tsig[ntsig++] = to;
  }
  for (u32 i = 1; i < k; i++) /* by the range's start, so like branches read alike */
    for (u32 j = i; j && tsig[at + 3 * j - 3] > tsig[at + 3 * j]; j--)
      for (u32 x = 0; x < 3; x++) { u32 t = tsig[at + 3 * j + x]; tsig[at + 3 * j + x] = tsig[at + 3 * j - 3 + x], tsig[at + 3 * j - 3 + x] = t; }
  for (u32 m = 0; m < ntmade; m++)
    if (tmadelen[m] == 3 * k && !memcmp(tsig + tmadeat[m], tsig + at, 12 * (u64)k)) { ntsig = at; return tmade[v] = tmadestate[m]; }
  u32 head = ~0u;
  for (u32 i = 0; i < k; i++) {
    u32 to = tsig[at + 3 * i + 2], j = 0;
    for (; j < i && tsig[at + 3 * j + 2] != to; j++) {}
    if (j < i) continue; /* gathered already, with the first edge going there */
    u64 b[4] = {0};
    for (u32 x = i; x < k; x++) if (tsig[at + 3 * x + 2] == to) bits_add(b, tsig[at + 3 * x], tsig[at + 3 * x + 1]);
    u32 s = state(S_SET, 0, set_of(b), to == ~0u ? 0 : to, 0);
    if (to == ~0u) thole = join_holes(hole_of(s, 0), thole);
    head = head == ~0u ? s : state(S_SPLIT, 0, 0, s, head);
  }
  if (ntmade == ctmade) {
    u32 *a = (u32 *)grab(12 * (u64)ctmade * 2);
    memcpy(a, tmadeat, 4 * (u64)ntmade), memcpy(a + 2 * ctmade, tmadelen, 4 * (u64)ntmade), memcpy(a + 4 * ctmade, tmadestate, 4 * (u64)ntmade);
    tmadeat = a, tmadelen = a + 2 * ctmade, tmadestate = a + 4 * ctmade, ctmade *= 2;
  }
  tmadeat[ntmade] = at, tmadelen[ntmade] = 3 * k, tmadestate[ntmade++] = head;
  return tmade[v] = head;
}
static struct frag cls_frag(struct cls *k) {
  cls_norm(k);
  if (!ctn) {
    ctn = cte = ctsig = ctmade = 64;
    tfirst = (u32 *)grab(4 * 64), tmade = (u32 *)grab(4 * 64), te = (struct tedge *)grab(sizeof *te * 64);
    tsig = (u32 *)grab(4 * 64), tmadeat = (u32 *)grab(12 * 64), tmadelen = tmadeat + 64, tmadestate = tmadeat + 128;
  }
  ntn = 0, nte = 1, ntsig = 0, ntmade = 0, thole = 0;
  tnode(), tnode();
  for (u32 i = 0; i < k->n; i++) tseqs(k->r[2 * i], k->r[2 * i + 1]);
  if (!tfirst[1]) { u64 b[4] = {0}; return one(S_SET, 0, set_of(b)); } /* nothing: a set of no byte */
  u32 s = temit(1);
  return (struct frag){s, thole};
}
