/*
 * you's regular expressions, as fd and rg read them (Rust's regex crate's syntax): literals and escapes, ., classes
 * ([a-z], [^…], \d \w \s and their negations, [[:alpha:]] and the other POSIX names), groups ((…), (?:…), (?i)…),
 * alternation, the quantifiers *, +, ?, {n}, {n,}, {n,m} and their lazy forms, and the assertions ^, $, \A, \z, \b, \B.
 * Text is UTF-8, and Unicode's as the crate's is: . and a negated class take a whole character; \w, \d, \s and \b are
 * Unicode's; case aside is Unicode's simple folding (k is K and K, the Kelvin sign) — the tables, unicode.h, made from
 * ripgrep's own answers. Not here: \p{…}, back-references and look-around (the last two not in the crate either).
 * Groups are numbered by their ( from the left, and named ((?P<name>…), (?<name>…)): where asked (RE_CAPTURE), where
 * each begins and ends in a match is found by re_captures, as -r's $1 and $name want it.
 *
 * Compiled to a Thompson automaton over bytes (a class's characters as a trie of their UTF-8 bytes, like branches made
 * one), run three ways: as a DFA made as it runs (dfa.c), which says which lines hold a match, and where one ends;
 * backwards, to where it starts (re_reverse); and as a Pike machine, where the DFA cannot say (a \b beside a character
 * past ASCII). Leftmost-first, as Rust's crate finds a match. Before any of it, what every match must hold: a pattern
 * that is only a literal is found by the literal alone, and one that holds a literal is run only where it is.
 */
#include "unicode.h"

enum { RE_ICASE = 1, RE_MULTILINE = 2, RE_LINES = 4, RE_CAPTURE = 8 };

/* A state: one byte of a set (SET), a choice of two (SPLIT, `out` first), a jump (JUMP), an assertion (ASSERT),
 * the match (MATCH), or where a group begins or ends (SAVE: slot `a`, 2 a group; a jump to all but re_captures). */
enum { S_SET, S_SPLIT, S_JUMP, S_ASSERT, S_MATCH, S_SAVE };
enum { A_BOL, A_EOL, A_BOT, A_EOT, A_WORD, A_NOTWORD };
struct rstate { u8 op, a; u16 set; u32 out, out1; };
/* A fragment as it is built: its first state and the list of its dangling exits (each an out to patch, threaded
 * through the outs themselves: the patch list). */
struct frag { u32 start, hole; };

struct re {
  struct rstate *st;
  u32 n, cap;
  u64 *sets; /* 256 bits each, each set once */
  u32 nsets, setcap;
  u16 *sethash; /* the sets by their bits (each its place + 1; 0: none), for set_of: twice as many places as sets */
  u32 sethmask;
  u8 *cls;      /* its bytes in classes, a class each set tells apart from the rest (dfa.c dfa_classes), once made */
  u32 ncls;
  u32 start;
  /* What every match must hold, and whether the pattern is that literal and nothing more (then case aside or not);
   * the places in it of its two rarest bytes (rare[0] < rare[1], one place twice when it is a byte), looked for first. */
  u8 *lit;
  u32 litn, rare[2];
  int only_lit, icase, lit_first; /* lit_first: every match begins with the literal */
  /* The assertions it holds: a word's edge (\b \B), a line's or the text's ends (^ $ \A \z). */
  int has_word, has_ends;
  /* What every match begins with, byte by byte, where that is rare enough to look for (firsts): nfirst bytes, the jth
   * one in one of first[j]'s ranges (lo, hi, inclusive), nrange[j] of them. */
  u32 nfirst;
  u8 first[4][4][2], nrange[4];
  struct re *rev; /* backwards (re_reverse), made when first asked for */
  /* Its groups (RE_CAPTURE): how many, and each one's name (gname[k][0..gnamen[k]), none: 0) by its number. */
  u32 groups;
  const u8 *gname[128];
  u32 gnamen[128];
};

static const char *re_error;
static const u8 *rp, *rend;
static struct re *R;
static int icase, multiline, lines, capture;

static u32 state(u8 op, u8 a, u16 set, u32 out, u32 out1) {
  if (R->n == R->cap) {
    struct rstate *m = (struct rstate *)grab(sizeof *m * R->cap * 2);
    memcpy(m, R->st, sizeof *m * R->n);
    R->st = m, R->cap *= 2;
  }
  R->st[R->n] = (struct rstate){op, a, set, out, out1};
  return R->n++;
}
/* Where the set b goes in the table of sets. */
static u32 set_hash(const u64 *b) {
  u64 h = b[0] * 0x9e3779b97f4a7c15ull ^ b[1] * 0xc2b2ae3d27d4eb4full ^ b[2] * 0x165667b19e3779f9ull ^ b[3] * 0x27d4eb2f165667c5ull;
  return (u32)(h ^ h >> 31) & R->sethmask;
}
/* The set of these 256 bits: the one already made that is the same, or a new one. Found by its bits in a table (a
 * Unicode class makes hundreds of sets, each looked for among those before it: \w took 3 ms to make). */
static u16 set_of(const u64 *b) {
  if (2 * (R->nsets + 1) > R->sethmask + 1) {
    R->sethmask = R->sethmask ? 2 * R->sethmask + 1 : 63;
    R->sethash = (u16 *)grab(2 * ((u64)R->sethmask + 1));
    memset(R->sethash, 0, 2 * ((u64)R->sethmask + 1));
    for (u32 i = 0; i < R->nsets; i++) {
      u32 h = set_hash(R->sets + 4 * i);
      while (R->sethash[h]) h = (h + 1) & R->sethmask;
      R->sethash[h] = (u16)(i + 1);
    }
  }
  u32 h = set_hash(b);
  for (; R->sethash[h]; h = (h + 1) & R->sethmask)
    if (!memcmp(R->sets + 4 * (R->sethash[h] - 1), b, 32)) return (u16)(R->sethash[h] - 1);
  R->sethash[h] = (u16)(R->nsets + 1);
  if (R->nsets == R->setcap) {
    u64 *m = (u64 *)grab(32 * (u64)R->setcap * 2);
    memcpy(m, R->sets, 32 * (u64)R->nsets);
    R->sets = m, R->setcap *= 2;
  }
  memcpy(R->sets + 4 * R->nsets, b, 32);
  return (u16)R->nsets++;
}
static void bits_add(u64 *b, u32 lo, u32 hi) {
  for (u32 c = lo; c <= hi && c < 256; c++) b[c >> 6] |= 1ull << (c & 63);
}
static int set_has(const u64 *b, u8 c) { return (b[c >> 6] >> (c & 63)) & 1; }

/* The holes of a fragment are outs set to the next hole's index + 1 (0: the last), so patching walks them. */
#define HOLE(i, which) ((which) ? &R->st[i].out1 : &R->st[i].out)
static u32 hole_of(u32 s, int which) { return (s << 1 | (u32)which) + 1; }
static void patch(u32 hole, u32 to) {
  while (hole) {
    u32 h = hole - 1, *p = HOLE(h >> 1, h & 1);
    hole = *p;
    *p = to;
  }
}
static u32 join_holes(u32 a, u32 b) {
  if (!a) return b;
  u32 h = a;
  for (;;) {
    u32 *p = HOLE((h - 1) >> 1, (h - 1) & 1);
    if (!*p) { *p = b; return a; }
    h = *p;
  }
}
static struct frag one(u8 op, u8 a, u16 set) {
  u32 s = state(op, a, set, 0, 0);
  return (struct frag){s, hole_of(s, 0)};
}
static struct frag cat(struct frag a, struct frag b) {
  if (a.start == ~0u) return b;
  if (b.start == ~0u) return a;
  patch(a.hole, b.start);
  return (struct frag){a.start, b.hole};
}
static struct frag alt(struct frag a, struct frag b) {
  if (a.start == ~0u) a = one(S_JUMP, 0, 0);
  if (b.start == ~0u) b = one(S_JUMP, 0, 0);
  u32 s = state(S_SPLIT, 0, 0, a.start, b.start);
  return (struct frag){s, join_holes(a.hole, b.hole)};
}
static const struct frag NONE = {~0u, 0};

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

/* ---- Parsing ---- */

static void bad(const char *why) { if (!re_error) re_error = why; }
static int more(void) { return rp < rend; }
static u32 next_char(void) { /* a character of the pattern, decoded */
  u32 c = *rp++;
  if (c < 0x80 || !more()) return c;
  u32 n = c >= 0xf0 ? 3 : c >= 0xe0 ? 2 : 1;
  c &= n == 3 ? 7 : n == 2 ? 15 : 31;
  while (n-- && more()) c = c << 6 | (*rp++ & 0x3f);
  return c;
}

/* \d \w \s (Unicode's) and their negations, into k. */
static void cls_named(struct cls *k, u8 name, int neg) {
  struct cls t;
  cls_init(&t);
  switch (name) {
    case 'd': cls_add(&t, '0', '9'), cls_table(&t, U_DIGIT, sizeof U_DIGIT); break;
    case 's': cls_add(&t, '\t', '\r'), cls_add(&t, ' ', ' '), cls_table(&t, U_SPACE, sizeof U_SPACE); break;
    default: cls_add(&t, '0', '9'), cls_add(&t, 'A', 'Z'), cls_add(&t, '_', '_'), cls_add(&t, 'a', 'z'), cls_table(&t, U_WORD, sizeof U_WORD);
  }
  if (neg) cls_negate(&t);
  for (u32 i = 0; i < t.n; i++) cls_add(k, t.r[2 * i], t.r[2 * i + 1]);
}
/* [:name:] at rp (ASCII's, as in the crate): 1 when it was one (added to k), else 0. */
static int posix_named(struct cls *k) {
  const char *names = "alnum\0alpha\0ascii\0blank\0cntrl\0digit\0graph\0lower\0print\0punct\0space\0upper\0word\0xdigit\0";
  const u8 *at = rp;
  if (rend - at < 4 || at[0] != '[' || at[1] != ':') return 0;
  int neg = at[2] == '^';
  const u8 *nm = at + 2 + neg, *e = nm;
  while (e < rend && *e != ':') e++;
  if (e + 1 >= rend || e[1] != ']') return 0;
  u32 len = (u32)(e - nm), which = 0;
  for (const char *s = names; *s; s += slen(s) + 1, which++) {
    if (slen(s) != len || memcmp(s, nm, len)) continue;
    struct cls t;
    cls_init(&t);
    switch (which) {
      case 0: cls_add(&t, '0', '9'), cls_add(&t, 'a', 'z'), cls_add(&t, 'A', 'Z'); break;
      case 1: cls_add(&t, 'a', 'z'), cls_add(&t, 'A', 'Z'); break;
      case 2: cls_add(&t, 0, 0x7f); break;
      case 3: cls_add(&t, ' ', ' '), cls_add(&t, '\t', '\t'); break;
      case 4: cls_add(&t, 0, 0x1f), cls_add(&t, 0x7f, 0x7f); break;
      case 5: cls_add(&t, '0', '9'); break;
      case 6: cls_add(&t, '!', '~'); break;
      case 7: cls_add(&t, 'a', 'z'); break;
      case 8: cls_add(&t, ' ', '~'); break;
      case 9: cls_add(&t, '!', '/'), cls_add(&t, ':', '@'), cls_add(&t, '[', '`'), cls_add(&t, '{', '~'); break;
      case 10: cls_add(&t, '\t', '\r'), cls_add(&t, ' ', ' '); break;
      case 11: cls_add(&t, 'A', 'Z'); break;
      case 12: cls_add(&t, '0', '9'), cls_add(&t, 'a', 'z'), cls_add(&t, 'A', 'Z'), cls_add(&t, '_', '_'); break;
      default: cls_add(&t, '0', '9'), cls_add(&t, 'a', 'f'), cls_add(&t, 'A', 'F');
    }
    if (icase) cls_fold(&t); /* (before it is negated, as the crate does: [[:^alpha:]] takes neither ſ nor s) */
    if (neg) cls_negate(&t);
    for (u32 i = 0; i < t.n; i++) cls_add(k, t.r[2 * i], t.r[2 * i + 1]);
    rp = e + 2;
    return 1;
  }
  bad("an unknown class name [:…:]");
  return 1;
}

/* An escape after \, at rp: a character (its code), or -1 when it was a class added to `k` (if any). */
static i64 escape(struct cls *k, int *named) {
  *named = 0;
  if (!more()) { bad("a \\ at the end"); return 0; }
  u8 c = *rp++;
  switch (c) {
    case 'n': return '\n';
    case 't': return '\t';
    case 'r': return '\r';
    case 'f': return '\f';
    case 'v': return '\v';
    case 'a': return 7;
    case '0': return 0;
    case 'x': case 'u': case 'U': {
      /* \x7F \x{10FFFF}; \u007F \u{7F}; \U0000007F \U{7F}: two, four or eight hex digits, or any in braces. */
      u32 v = 0, n = 0, brace = more() && *rp == '{', most = c == 'x' ? 2 : c == 'u' ? 4 : 8;
      if (brace) rp++;
      while (more() && (brace || n < most)) {
        u8 h = *rp;
        u32 d = h >= '0' && h <= '9' ? h - '0' : (h | 0x20) >= 'a' && (h | 0x20) <= 'f' ? (h | 0x20) - 'a' + 10 : 99;
        if (d == 99) break;
        v = v * 16 + d, rp++, n++;
      }
      if (brace) { if (more() && *rp == '}') rp++; else bad("\\x{ not closed"); }
      if (!n || (!brace && n < most)) bad("\\x without its digits");
      if (v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) bad("\\x of no character");
      return v;
    }
    case 'd': case 'D': case 'w': case 'W': case 's': case 'S':
      if (k) cls_named(k, (u8)(c | 0x20), c < 'a');
      *named = 1;
      return -1;
  }
  if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) bad("an escape this does not know");
  return c;
}

/* Two classes made one by a set operation: && both, -- the first's not the second's, ~~ either's not both's. */
static int set_op(void) {
  return rend - rp >= 2 && rp[0] == rp[1] && (rp[0] == '&' || rp[0] == '-' || rp[0] == '~') ? rp[0] : 0;
}
static void cls_apply(struct cls *a, struct cls *b, int op) {
  cls_norm(a), cls_norm(b);
  u32 n = a->n, *r = a->r, i = 0, j = 0;
  cls_init(a);
  if (op == '~') { /* either's, less both's */
    struct cls both;
    cls_init(&both);
    for (u32 x = 0; x < n; x++) cls_add(&both, r[2 * x], r[2 * x + 1]);
    cls_apply(&both, b, '&');
    for (u32 x = 0; x < n; x++) cls_add(a, r[2 * x], r[2 * x + 1]);
    for (u32 x = 0; x < b->n; x++) cls_add(a, b->r[2 * x], b->r[2 * x + 1]);
    cls_apply(a, &both, '-');
    return;
  }
  if (op == '-') cls_negate(b);
  while (i < n && j < b->n) { /* both sorted: what each pair of ranges shares */
    u32 lo = r[2 * i] > b->r[2 * j] ? r[2 * i] : b->r[2 * j], hi = r[2 * i + 1] < b->r[2 * j + 1] ? r[2 * i + 1] : b->r[2 * j + 1];
    if (lo <= hi) cls_add(a, lo, hi);
    if (r[2 * i + 1] < b->r[2 * j + 1]) i++; else j++;
  }
}

/* A class in brackets, after its [: Rust's crate's grammar. Its items (a character, a range, an escape, \d and the
 * like, [:name:], or a class in brackets of its own) are one class; classes joined by &&, -- or ~~ are taken left to
 * right; case aside, each is folded before it is joined; a ^ at its start negates the whole, last. A ] first is a
 * character, as a - first or last is. */
static void class_set(struct cls *k, int depth) {
  if (depth > 100) { bad("classes too deep"); return; }
  int neg = more() && *rp == '^', op = 0;
  if (neg) rp++;
  cls_init(k);
  for (int first = 1;; first = 0) {
    struct cls part;
    cls_init(&part);
    for (int lead = first; more() && (lead || *rp != ']') && !set_op() && !re_error; lead = 0) {
      if (*rp == '[') {
        if (posix_named(&part)) continue;
        rp++;
        struct cls sub;
        class_set(&sub, depth + 1);
        for (u32 x = 0; x < sub.n; x++) cls_add(&part, sub.r[2 * x], sub.r[2 * x + 1]);
        continue;
      }
      i64 lo;
      int named;
      if (*rp == '\\') { rp++; lo = escape(&part, &named); if (named) continue; }
      else lo = next_char();
      i64 hi = lo;
      if (rend - rp >= 2 && rp[0] == '-' && rp[1] != ']' && rp[1] != '-') {
        rp++;
        if (*rp == '\\') { rp++; hi = escape(0, &named); if (named) bad("a range to a class"); }
        else hi = next_char();
        if (hi < lo) bad("a range backwards");
      }
      cls_add(&part, (u32)lo, (u32)hi);
    }
    if (icase) cls_fold(&part); /* (folded, then negated: [^a] with case aside takes neither a nor A) */
    if (first) for (u32 x = 0; x < part.n; x++) cls_add(k, part.r[2 * x], part.r[2 * x + 1]);
    else cls_apply(k, &part, op);
    if (!(op = set_op())) break;
    rp += 2;
  }
  if (!more()) { bad("a [ not closed"); return; }
  rp++;
  if (neg) cls_negate(k);
}

static struct frag bracket(void) {
  struct cls k;
  class_set(&k, 0);
  if (re_error) return NONE;
  return cls_frag(&k);
}

static struct frag lit_char(u32 c) {
  struct cls k;
  cls_init(&k);
  cls_add(&k, c, c);
  if (icase) cls_fold(&k);
  return cls_frag(&k);
}

static struct frag alternation(int depth);

static struct frag atom(int depth) {
  u8 c = *rp;
  if (c == '(') {
    rp++;
    int save = icase, save_m = multiline;
    const u8 *name = 0;
    u32 namen = 0;
    int captures = 1;
    if (more() && *rp == '?' && rp + 1 < rend && (rp[1] == '<' || (rp[1] == 'P' && rp + 2 < rend && rp[2] == '<'))) {
      rp += rp[1] == 'P' ? 3 : 2; /* (?P<name>…) or (?<name>…): a group with a name */
      name = rp;
      while (more() && *rp != '>') rp++;
      namen = (u32)(rp - name);
      if (!more() || !namen) { bad("a group's name not closed"); return NONE; }
      rp++;
    } else if (more() && *rp == '?') {
      captures = 0;
      rp++;
      int on = 1, group = 0;
      while (more() && *rp != ')' && *rp != ':') {
        u8 f = *rp++;
        if (f == '-') on = 0;
        else if (f == 'i') icase = on;
        else if (f == 'm') multiline = on;
        else if (f == 's' || f == 'x' || f == 'U' || f == 'u') {} /* (s: . takes \n; here . is one line's) */
        else { bad("a flag this does not know"); break; }
      }
      if (more() && *rp == ':') group = 1, rp++;
      if (!group) { /* (?i) alone: for the rest of the group it stands in */
        if (more()) rp++;
        return NONE;
      }
    }
    /* Its number, from the left by its (, before those inside it. */
    u32 k = captures ? ++R->groups : 0;
    if (k && k < 128) R->gname[k] = name, R->gnamen[k] = namen;
    struct frag f = alternation(depth + 1);
    if (!more() || *rp != ')') bad("a ( not closed");
    else rp++;
    icase = save, multiline = save_m;
    if (!capture || !k || k > 127) return f;
    return cat(cat(one(S_SAVE, (u8)(2 * k), 0), f), one(S_SAVE, (u8)(2 * k + 1), 0));
  }
  rp++;
  switch (c) {
    case '.': {
      struct cls k;
      cls_init(&k);
      cls_add(&k, 0, '\n' - 1), cls_add(&k, '\n' + 1, 0x10ffff);
      return cls_frag(&k);
    }
    case '[': return bracket();
    case '^': R->has_ends = 1; return one(S_ASSERT, multiline || lines ? A_BOL : A_BOT, 0);
    case '$': R->has_ends = 1; return one(S_ASSERT, multiline || lines ? A_EOL : A_EOT, 0);
    case '\\': {
      if (more() && (*rp == 'b' || *rp == 'B' || *rp == 'A' || *rp == 'z')) {
        u8 a = *rp++;
        if (a == 'b' || a == 'B') R->has_word = 1; else R->has_ends = 1;
        /* (each line is the text when matching lines: \A and \z are its ends) */
        return one(S_ASSERT, a == 'b' ? A_WORD : a == 'B' ? A_NOTWORD : a == 'A' ? (lines ? A_BOL : A_BOT) : lines ? A_EOL : A_EOT, 0);
      }
      struct cls k;
      cls_init(&k);
      int named;
      i64 v = escape(&k, &named);
      return named ? cls_frag(&k) : lit_char((u32)v);
    }
    case '*': case '+': case '?': case '{': bad("a repetition of nothing"); return NONE;
    default: rp--; return lit_char(next_char());
  }
}

static u32 number(void) {
  u32 v = 0;
  if (!more() || *rp < '0' || *rp > '9') { bad("a count expected"); return 0; }
  while (more() && *rp >= '0' && *rp <= '9') v = v * 10 + (*rp++ - '0');
  if (v > 1000) bad("a count past 1000");
  return v;
}

/* The atom at `a0` again, as it was first read (a fresh copy of its states, for a counted repetition). */
static const u8 *atom_at;
static int atom_icase, atom_multiline;
static u32 atom_groups;
static struct frag atom_again(int depth) {
  const u8 *save = rp, *at = atom_at;
  int ic = icase, ml = multiline, aic = atom_icase, aml = atom_multiline;
  u32 g = R->groups, ag = atom_groups;
  /* Its groups numbered as they were the first time; and what a repetition inside it sets here, put back after (an
   * atom repeated holding one repeated: ((a){2}){3}). */
  rp = atom_at, icase = atom_icase, multiline = atom_multiline, R->groups = atom_groups;
  struct frag f = atom(depth);
  rp = save, icase = ic, multiline = ml, R->groups = g;
  atom_at = at, atom_icase = aic, atom_multiline = aml, atom_groups = ag;
  return f;
}

/* f repeated lo to hi times (hi ~0: no end), greedy or lazy: lo copies, then hi - lo optional ones (or a loop). */
static struct frag repeat(struct frag f, u32 lo, u32 hi, int lazy, int depth) {
  if (f.start == ~0u) return f;
  struct frag out = NONE, piece = f;
  for (u32 i = 0; i < lo; i++) {
    out = cat(out, piece);
    if (i + 1 < lo || hi != lo) piece = atom_again(depth);
  }
  if (hi == ~0u) { /* piece*, after the required ones */
    u32 s = state(S_SPLIT, 0, 0, 0, 0);
    patch(piece.hole, s);
    if (lazy) R->st[s].out1 = piece.start; else R->st[s].out = piece.start;
    return cat(out, (struct frag){s, hole_of(s, !lazy)});
  }
  for (u32 i = lo; i < hi; i++) { /* piece? each, nested so that a later one is tried only after an earlier */
    u32 s = state(S_SPLIT, 0, 0, 0, 0);
    if (lazy) R->st[s].out1 = piece.start; else R->st[s].out = piece.start;
    out = cat(out, (struct frag){s, join_holes(piece.hole, hole_of(s, !lazy))});
    if (i + 1 < hi) piece = atom_again(depth);
  }
  return out;
}

static struct frag concatenation(int depth) {
  struct frag f = NONE;
  while (more() && *rp != '|' && *rp != ')' && !re_error) {
    const u8 *a0 = rp;
    int ic = icase, ml = multiline;
    u32 g0 = R->groups;
    struct frag a = atom(depth);
    while (more() && !re_error && (*rp == '*' || *rp == '+' || *rp == '?' || *rp == '{')) {
      u8 q = *rp++;
      u32 lo = 0, hi = ~0u;
      if (q == '+') lo = 1;
      else if (q == '?') hi = 1;
      else if (q == '{') {
        lo = hi = number();
        if (more() && *rp == ',') { rp++; hi = more() && *rp == '}' ? ~0u : number(); }
        if (!more() || *rp != '}') { bad("a { not closed"); break; }
        rp++;
        if (hi < lo) bad("a count backwards");
      }
      int lazy = more() && *rp == '?';
      if (lazy) rp++;
      atom_at = a0, atom_icase = ic, atom_multiline = ml, atom_groups = g0;
      a = repeat(a, lo, hi, lazy, depth);
      break; /* one quantifier an atom: another after it is a repetition of nothing, as in Rust's crate */
    }
    f = cat(f, a);
  }
  return f;
}

static struct frag alternation(int depth) {
  if (depth > 100) { bad("groups too deep"); return NONE; }
  struct frag f = concatenation(depth);
  while (more() && *rp == '|' && !re_error) {
    rp++;
    f = alt(f, concatenation(depth));
  }
  return f;
}

/* ---- What every match holds: the longest run of plain characters in the pattern's top-level sequence (a run's last
 * character dropped when a *, ? or {…} follows it, which may take it away; a + keeps it). None when the pattern has a
 * top-level alternation or sets flags past its start. Case aside (by the flags given, or a (?i) the pattern begins
 * with): every byte of it small, and a run broken at a character whose case is past ASCII (k: K, the Kelvin sign; s: ſ;
 * any past ASCII). `only_lit`: the pattern is that literal and nothing else. */

/* The index after the class in brackets at i, past the classes in it (its escapes, [:name:] and a leading ] too). */
static u32 skip_class(const u8 *p, u32 n, u32 i) {
  i++;
  if (i < n && p[i] == '^') i++;
  if (i < n && p[i] == ']') i++;
  while (i < n && p[i] != ']') {
    if (p[i] == '\\') i += 2;
    else if (p[i] == '[' && i + 1 < n && p[i + 1] == ':') {
      u32 j = i + 2;
      while (j + 1 < n && !(p[j] == ':' && p[j + 1] == ']')) j++;
      i = j + 2;
    } else if (p[i] == '[') i = skip_class(p, n, i);
    else i++;
  }
  return i + 1;
}
/* The index after the token at i that is not a plain character: an escape (\x41, \x{…}, \d…), a class ([…], with
 * its own escapes, [:name:] and a leading ]) or a count ({n,m}); one byte for anything else. */
static u32 skip_token(const u8 *p, u32 n, u32 i) {
  if (p[i] == '\\') {
    i++;
    if (i < n && (p[i] == 'x' || p[i] == 'u' || p[i] == 'U')) {
      u32 most = p[i] == 'x' ? 2 : p[i] == 'u' ? 4 : 8;
      i++;
      if (i < n && p[i] == '{') { while (i < n && p[i] != '}') i++; return i + 1; }
      return i + most > n ? n : i + most;
    }
    return i + 1;
  }
  if (p[i] == '[') return skip_class(p, n, i);
  if (p[i] == '{') { while (i < n && p[i] != '}') i++; return i + 1; }
  return i + 1;
}

/* How common each byte is in text as code is (0 the rarest, 255 the most common: a space), from a corpus of this
 * repository's own source (C, Rust, TypeScript, shell, Markdown): a literal is looked for by its two rarest bytes, as
 * ripgrep does, not by its first and last ("fn " found by its f and n, not by every f two before a space). */
static const u8 RARITY[256] = {
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 239, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
  255, 198, 220, 169, 178, 124, 209, 234, 243, 244, 213, 176, 238, 211, 242, 228, 216, 204, 194, 191, 188, 171, 184, 159, 172, 160, 233, 231, 189, 227, 215, 196,
  117, 202, 182, 193, 185, 212, 181, 170, 180, 199, 137, 166, 192, 187, 195, 200, 197, 90, 205, 214, 210, 174, 168, 179, 136, 148, 99, 208, 177, 207, 131, 219,
  203, 251, 226, 240, 245, 254, 232, 229, 241, 247, 183, 222, 246, 235, 250, 249, 237, 190, 248, 252, 253, 236, 221, 230, 217, 223, 173, 225, 201, 224, 89, 31,
  163, 206, 186, 175, 139, 110, 123, 103, 151, 158, 140, 155, 152, 141, 86, 127, 125, 97, 132, 149, 102, 138, 120, 156, 93, 146, 133, 143, 121, 101, 87, 129,
  109, 116, 104, 96, 130, 105, 150, 147, 122, 107, 126, 154, 94, 119, 162, 153, 92, 91, 88, 134, 95, 100, 98, 115, 118, 113, 111, 108, 165, 106, 161, 114,
  32, 33, 112, 85, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61,
  62, 63, 135, 218, 144, 167, 164, 145, 142, 128, 64, 65, 66, 67, 68, 157, 84, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83
};
static u32 rarity(u8 c, int ci) {
  u32 r = RARITY[c];
  if (ci && c >= 'a' && c <= 'z' && RARITY[c - 32] > r) r = RARITY[c - 32];
  return r;
}

/* Whether a character's circle of case reaches past ASCII. */
static int case_wide(u32 c) {
  struct cls k;
  cls_init(&k);
  cls_add(&k, c, c);
  cls_fold(&k);
  return k.r[2 * k.n - 1] >= 0x80;
}

static void required(struct re *r, const u8 *p, u32 n, int ci) {
  u32 from = 0;
  if (n >= 4 && p[0] == '(' && p[1] == '?') { /* flags for the whole pattern, at its start */
    u32 i = 2;
    int on = 1;
    for (; i < n && p[i] != ')' && p[i] != ':'; i++)
      if (p[i] == '-') on = 0;
      else if (p[i] == 'i') ci = on;
    if (i < n && p[i] == ')') from = i + 1;
  }
  int depth = 0;
  for (u32 i = from; i < n;) {
    if (p[i] == '(' && i + 1 < n && p[i + 1] == '?') return; /* its own flags: case may differ inside */
    if (p[i] == '(') depth++;
    else if (p[i] == ')') depth--;
    else if (p[i] == '|' && !depth) return;
    i = p[i] == '\\' || p[i] == '[' || p[i] == '{' ? skip_token(p, n, i) : i + 1;
  }
  /* (A run's characters as they are matched: a character escaped that stands for itself is itself, one byte.) */
  u8 *cur = grab(n + 1), *lit = grab(n + 1);
  u32 best = 0, bestat = 0, run = 0, at = 0;
  int plain_only = 1;
  depth = 0;
  for (u32 i = from; i <= n;) {
    u8 c = i < n ? p[i] : 0;
    /* \. \- \( \\ and the rest of ASCII's punctuation escaped: the character (-F's patterns are all such); not \< or
     * \>, a word's edges. */
    u8 e = i + 1 < n ? p[i + 1] : 0;
    int escaped = c == '\\' && e >= ' ' && e < 0x7f && !((e | 0x20) >= 'a' && (e | 0x20) <= 'z') && !(e >= '0' && e <= '9')
      && e != '_' && e != '<' && e != '>';
    if (escaped) c = e;
    int meta = !escaped && (c == '\\' || c == '.' || c == '[' || c == '(' || c == ')' || c == '|' || c == '*' || c == '+' || c == '?'
      || c == '{' || c == '^' || c == '$');
    int wide = i < n && ci && (c >= 0x80 || case_wide(c));
    if (i < n && !depth && !meta && !wide) { if (!run) at = i; cur[run++] = c; i += escaped ? 2 : 1; continue; }
    if (i < n) plain_only = 0;
    if (run && !escaped && (c == '*' || c == '?' || c == '{')) run--; /* its last character repeated, or not there at all */
    if (run > best) best = run, bestat = at, memcpy(lit, cur, run);
    run = 0;
    if (i >= n) break;
    if (!escaped && c == '(') depth++;
    else if (!escaped && c == ')' && depth) depth--;
    i = escaped ? i + 2 : meta ? skip_token(p, n, i) : i + 1;
  }
  if (!best) return;
  r->lit = grab(best);
  r->litn = best;
  for (u32 i = 0; i < best; i++) {
    u8 c = lit[i];
    r->lit[i] = ci && c >= 'A' && c <= 'Z' ? c | 0x20 : c;
  }
  r->only_lit = plain_only;
  r->lit_first = bestat == from;
  r->icase = ci;
  /* Its two rarest bytes (in text as code is, either case where case is aside): where it is looked for. */
  u32 a = 0, b = 0;
  for (u32 i = 1; i < best; i++) {
    u32 ri = rarity(r->lit[i], ci);
    if (ri < rarity(r->lit[a], ci)) b = a, a = i;
    else if (b == a || ri < rarity(r->lit[b], ci)) b = i;
  }
  r->rare[0] = a < b ? a : b, r->rare[1] = a < b ? b : a;
}

/*
 * What every match begins with, a byte at a time: the bytes the states reached from the start with none read can take
 * (its first), those the states they lead to can take (its second), and so on, while no match can have ended (the
 * match state is not reached), each such set a few ranges, and none of them most of what text holds. Where they make
 * a match rare enough among a text's places (each's share of text's bytes, multiplied: under 1/32), they are kept
 * (grep.c: a text's places looked at 16 or 32 bytes at a time for those that begin so, each asked of the DFA there).
 */
static u32 share(const u64 *b) { /* a set's share of a text's bytes, in 1/1024: printable ASCII and tab as common, the rest rare */
  u32 w = 0;
  for (u32 c = 0; c < 256; c++)
    if (b[c >> 6] >> (c & 63) & 1) w += (c >= 0x20 && c < 0x7f) || c == '\t' ? 1024 / 96 : 0;
  return w + 1;
}
static void firsts(struct re *r) {
  u32 n = r->n, *mark = (u32 *)grab(4 * (u64)n), *now = (u32 *)grab(4 * (u64)n), *stack = (u32 *)grab(8 * (u64)n + 8);
  memset(mark, 0xff, 4 * (u64)n);
  u32 nnow = 1, odds = 1024; /* (the share of places that begin so, in 1/1024: a product) */
  now[0] = r->start;
  r->nfirst = 0;
  for (u32 j = 0; j < 4 && nnow; j++) {
    /* The states reached with no byte read: those that take a byte, and whether a match ends here. */
    u64 b[4] = {0};
    u32 top = 0, sets = 0, ended = 0;
    for (u32 k = 0; k < nnow; k++) stack[top++] = now[k];
    while (top) {
      u32 v = stack[--top];
      if (mark[v] == j) continue;
      mark[v] = j;
      struct rstate *st = &r->st[v];
      if (st->op == S_MATCH) ended = 1;
      else if (st->op == S_SET) { for (int w = 0; w < 4; w++) b[w] |= r->sets[4 * st->set + w]; now[sets++] = v; }
      else if (st->op == S_SPLIT) stack[top++] = st->out1, stack[top++] = st->out;
      else stack[top++] = st->out; /* a jump, an assertion (it only narrows) */
    }
    if (ended) break;
    /* As ranges, four at most. */
    u32 nr = 0;
    for (u32 c = 0; c < 256 && nr <= 4;) {
      if (!(b[c >> 6] >> (c & 63) & 1)) { c++; continue; }
      u32 e = c;
      while (e + 1 < 256 && b[(e + 1) >> 6] >> ((e + 1) & 63) & 1) e++;
      if (nr < 4) r->first[j][nr][0] = (u8)c, r->first[j][nr][1] = (u8)e;
      nr++;
      c = e + 1;
    }
    u32 sh = share(b);
    if (!nr || nr > 4 || sh > 1024 * 6 / 10) break;
    r->nrange[j] = (u8)nr;
    r->nfirst = j + 1;
    odds = odds * sh / 1024;
    /* What those states lead to. */
    u32 next = 0;
    for (u32 k = 0; k < sets; k++) stack[next++] = r->st[now[k]].out;
    for (u32 k = 0; k < next; k++) now[k] = stack[k];
    nnow = next;
  }
  if (odds * 32 > 1024) r->nfirst = 0;
}

static struct re *re_compile(const u8 *pat, u32 n, int flags) {
  struct re *r = (struct re *)grab(sizeof *r);
  memset(r, 0, sizeof *r);
  r->cap = 64, r->st = (struct rstate *)grab(sizeof *r->st * 64);
  r->setcap = 16, r->sets = (u64 *)grab(32 * 16);
  R = r, re_error = 0, rp = pat, rend = pat + n, icase = flags & RE_ICASE, multiline = flags & RE_MULTILINE;
  lines = flags & RE_LINES, capture = flags & RE_CAPTURE;
  struct frag f = alternation(0);
  if (more() && !re_error) bad("a ) not opened");
  if (re_error) return 0;
  u32 m = state(S_MATCH, 0, 0, 0, 0);
  patch(f.hole, m);
  if (lines) for (u32 i = 0; i < r->nsets; i++) r->sets[4 * i] &= ~(1ull << '\n'); /* no match crosses a line */
  r->start = f.start == ~0u ? m : f.start;
  required(r, pat, n, flags & RE_ICASE);
  firsts(r);
  return r;
}

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

/* ---- Running it ---- */

/* Whether a character is a word's (\w): ASCII's by its bytes, Unicode's by U_WORD, read once into ranges. */
static u32 *wordr, nwordr;
static int char_word(u32 c) {
  if (c < 0x80) return c == '_' || (u32)((c | 0x20) - 'a') < 26u || (u32)(c - '0') < 10u;
  if (!wordr) {
    struct cls k;
    cls_init(&k);
    cls_table(&k, U_WORD, sizeof U_WORD);
    wordr = k.r, nwordr = k.n;
  }
  u32 lo = 0, hi = nwordr;
  while (lo < hi) {
    u32 mid = (lo + hi) / 2;
    if (c > wordr[2 * mid + 1]) lo = mid + 1;
    else hi = mid;
  }
  return lo < nwordr && c >= wordr[2 * lo];
}
/* The character at s[i] (decoded, or ~0 when the bytes there are not one), and its length (1 when not one). */
static u32 decode(const u8 *s, u64 n, u64 i, u32 *len) {
  u8 b = s[i];
  *len = 1;
  if (b < 0x80) return b;
  u32 k = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 0;
  if (!k || b > 0xf4 || i + k > n) return ~0u;
  u32 c = b & (0x7f >> k);
  for (u32 j = 1; j < k; j++) {
    if ((s[i + j] & 0xc0) != 0x80) return ~0u;
    c = c << 6 | (s[i + j] & 0x3f);
  }
  if ((k == 2 && c < 0x80) || (k == 3 && (c < 0x800 || (c >= 0xd800 && c <= 0xdfff))) || (k == 4 && (c < 0x10000 || c > 0x10ffff))) return ~0u;
  *len = k;
  return c;
}
/* Whether a word's character begins at i / ends just before i, in s[0..n): 1, 0, or -1 when the bytes there are not a
 * character (as Rust's crate reads them: then neither \b nor \B holds there). */
static int word_at(const u8 *s, u64 n, u64 i) {
  if (i >= n) return 0;
  u32 len, c = decode(s, n, i, &len);
  return c == ~0u ? -1 : char_word(c);
}
static int word_before(const u8 *s, u64 n, u64 i) {
  if (!i) return 0;
  if (s[i - 1] < 0x80) return char_word(s[i - 1]);
  for (u64 j = i - 1, k = 0; k < 4; j--, k++) {
    if ((s[j] & 0xc0) != 0x80) {
      u32 len, c = decode(s, n, j, &len);
      return c != ~0u && j + len == i ? char_word(c) : -1;
    }
    if (!j) break;
  }
  return -1;
}
/* Whether assertion a holds at i in t[0..n). */
static int holds(u8 a, const u8 *t, u64 n, u64 i) {
  switch (a) {
    case A_BOT: return i == 0;
    case A_EOT: return i == n;
    case A_BOL: return i == 0 || t[i - 1] == '\n';
    case A_EOL: return i == n || t[i] == '\n';
    case A_WORD: return (word_before(t, n, i) == 1) != (word_at(t, n, i) == 1);
    default: {
      int b = word_before(t, n, i), w = word_at(t, n, i);
      return b >= 0 && w >= 0 && b == w;
    }
  }
}

/* Where a literal is in s[from..n), case aside when told (the literal small): its place, or n. Sixty-four places at
 * a time: where its two rarest bytes (rare[]) are both (either case, when case is aside), the four registers' pairs
 * ORed and one mask asked of them, then the rest compared where some are. */
typedef char v16 __attribute__((vector_size(16)));
static inline v16 ld128(const u8 *p) { v16 v; __builtin_memcpy(&v, p, 16); return v; }
static inline v16 splat(u8 c) { return (v16){0} + (char)c; }
static inline u32 mask16(v16 v) { return (u32)__builtin_ia32_pmovmskb128(v); }
static inline u8 up(u8 c) { return c >= 'a' && c <= 'z' ? c - 32 : c; }
/* The two places of a literal it is looked for by (a < b), and how they do in a text: the places where both bytes are
 * but not the literal (miss), over the bytes passed (seen). Rare bytes alone choose them first (RARITY), but two rare
 * bytes are not always a rare pair: "performance"'s f and m, three apart, are "from"'s. More than one such place in 2
 * KiB, past the first 64, and the pair is chosen again, by the text: of the pairs among the literal's six rarest
 * places, the one at the fewest places in its last 8 KiB passed. Four times at most (a text where every pair is common
 * is not asked again and again). Each search's own (struct grep), kept from text to text. */
struct pair { u32 a, b, changes; u64 miss, seen, stop; };
static void pair_init(struct pair *pp, const struct re *r) {
  pp->a = r->rare[0], pp->b = r->rare[1], pp->changes = 0, pp->miss = pp->seen = 0;
}
/* Another place found that is not the literal, `passed` bytes into this look: whether the pair is to be chosen again. */
static inline int pair_poor(struct pair *pp, u64 passed) {
  return !(++pp->miss & 63) && pp->changes < 4 && pp->miss * 2048 > pp->seen + passed;
}
/* How many of the places in s[lo..hi) have fa at a and fb at b (case aside when told), 16 at a time (the last few,
 * under 16, left out). */
static u64 pair_count(const u8 *s, u64 lo, u64 hi, u32 a, u32 b, u8 fa, u8 fb, int ci) {
  v16 A0 = splat(fa), A1 = splat(ci ? up(fa) : fa), B0 = splat(fb), B1 = splat(ci ? up(fb) : fb);
  u64 c = 0;
  for (u64 p = lo; p + 16 <= hi; p += 16) {
    v16 w = ld128(s + p + a), y = ld128(s + p + b);
    for (u32 m = mask16(((w == A0) | (w == A1)) & ((y == B0) | (y == B1))); m; m &= m - 1) c++; /* (no popcount: sys.h) */
  }
  return c;
}
/* The pair chosen again, by s's 8 KiB before i (all of it passed, each place's literal within s). */
static void pair_change(struct pair *pp, const u8 *s, u64 i, const u8 *lit, u32 litn, int ci) {
  u32 at[6], k = 0;
  for (; k < 6 && k < litn; k++) { /* the six rarest places, rarest first */
    u32 best = ~0u;
    for (u32 j = 0; j < litn; j++) {
      int taken = 0;
      for (u32 h = 0; h < k; h++) taken |= at[h] == j;
      if (!taken && (best == ~0u || rarity(lit[j], ci) < rarity(lit[best], ci))) best = j;
    }
    at[k] = best;
  }
  u64 lo = i > 8192 ? i - 8192 : 0, fewest = ~0ull;
  for (u32 x = 0; x < k; x++)
    for (u32 y = x + 1; y < k; y++) {
      u32 a = at[x] < at[y] ? at[x] : at[y], b = at[x] ^ at[y] ^ a;
      u64 c = pair_count(s, lo, i, a, b, lit[a], lit[b], ci);
      if (c < fewest) fewest = c, pp->a = a, pp->b = b;
    }
  pp->changes++, pp->miss = pp->seen = 0;
}
/* Whether this core runs AVX2 and the kernel keeps its registers (cpuid's leaf 7, and XGETBV's YMM state): a part of
 * the text is then looked at 64 bytes a step. xlat (the browser) says it has no AVX: there the 16-byte way. Asked once,
 * before any thread (grep_init). */
static int avx2;
static void avx2_ask(void) {
#ifdef YOU_16 /* (built so by its checks, test/regex.sh: the 16-byte way, as the browser goes, on a core that has more) */
  return;
#endif
  u32 a, b, c, d;
  __asm__("cpuid" : "=a"(a), "=b"(b), "=c"(c), "=d"(d) : "a"(0), "c"(0));
  if (a < 7) return;
  __asm__("cpuid" : "=a"(a), "=b"(b), "=c"(c), "=d"(d) : "a"(1), "c"(0));
  if (!(c & (1u << 27)) || !(c & (1u << 28))) return; /* OSXSAVE, AVX */
  u32 lo, hi;
  __asm__("xgetbv" : "=a"(lo), "=d"(hi) : "c"(0));
  if ((lo & 6) != 6) return; /* the XMM and YMM state kept */
  __asm__("cpuid" : "=a"(a), "=b"(b), "=c"(c), "=d"(d) : "a"(7), "c"(0));
  avx2 = (b >> 5) & 1;
}
typedef char v32 __attribute__((vector_size(32)));
__attribute__((target("avx2"))) static inline v32 ld256(const u8 *p) { v32 v; __builtin_memcpy(&v, p, 32); return v; }
__attribute__((target("avx2"))) static inline u32 mask32(v32 v) { return (u32)__builtin_ia32_pmovmskb256(v); }
/* lit_find (below), 128 places a step, in 32-byte registers: the four steps' pairs ORed, one mask asked of them (the
 * text read at the memory's pace: two masks and two branches for each 64 places kept the core, not the memory, the
 * bound); the places where both bytes are, in order, only where some are. */
__attribute__((target("avx2"))) static inline u64 two32(v32 lo, v32 hi) { return (u64)mask32(lo) | (u64)mask32(hi) << 32; }
/* Where the 32 places at f hold F0 or F1 and those at l hold L0 or L1: the pair, case aside. */
__attribute__((target("avx2"))) static inline v32 either2(const u8 *f, const u8 *l, v32 F0, v32 F1, v32 L0, v32 L1) {
  v32 x = ld256(f), y = ld256(l);
  return ((x == F0) | (x == F1)) & ((y == L0) | (y == L1));
}
/* lit_find_avx2's steps, `one` (each byte one way) a constant where it is called: each way its own loop (one loop
 * asking `one` at each step kept the four registers on the stack between the two ways). */
__attribute__((target("avx2"), always_inline)) static inline u64 lit_steps(const u8 *s, u64 n, u64 from, const u8 *lit, u32 litn, int ci, struct pair *pp, int one) {
  u32 a = pp->a, b = pp->b;
  u8 f0 = lit[a], l0 = lit[b];
  u64 i = from, last = n - litn;
  v32 F0 = (v32){0} + (char)f0, F1 = (v32){0} + (char)up(f0), L0 = (v32){0} + (char)l0, L1 = (v32){0} + (char)up(l0);
  for (; i + 128 <= last + 1; i += 128) {
    const u8 *p = s + i;
    v32 x0, x1, x2, x3;
    if (one) {
      x0 = (ld256(p + a) == F0) & (ld256(p + b) == L0);
      x1 = (ld256(p + 32 + a) == F0) & (ld256(p + 32 + b) == L0);
      x2 = (ld256(p + 64 + a) == F0) & (ld256(p + 64 + b) == L0);
      x3 = (ld256(p + 96 + a) == F0) & (ld256(p + 96 + b) == L0);
    } else {
      x0 = either2(p + a, p + b, F0, F1, L0, L1);
      x1 = either2(p + 32 + a, p + 32 + b, F0, F1, L0, L1);
      x2 = either2(p + 64 + a, p + 64 + b, F0, F1, L0, L1);
      x3 = either2(p + 96 + a, p + 96 + b, F0, F1, L0, L1);
    }
    if (__builtin_expect(!mask32(x0 | x1 | x2 | x3), 1)) continue;
    /* (No array here: in a function of target("avx2") GCC forgets -mstack-protector-guard=global, and an array's
     * canary is read from a thread's storage there is none of.) */
    for (u64 k = two32(x0, x1), at = i;; k = two32(x2, x3), at += 64) {
      for (; k; k &= k - 1) {
        u64 q = at + (u32)__builtin_ctzll(k);
        if (ci ? eqi(s + q, lit, litn) : eq(s + q, lit, litn)) return q;
        if (pair_poor(pp, q - from)) { pp->stop = i; return n; }
      }
      if (at != i) break;
    }
  }
  for (; i <= last; i++)
    if ((s[i + a] == f0 || (ci && up(s[i + a]) == up(f0))) && (ci ? eqi(s + i, lit, litn) : eq(s + i, lit, litn))) return i;
  return n;
}
__attribute__((target("avx2"))) static u64 lit_find_avx2(const u8 *s, u64 n, u64 from, const u8 *lit, u32 litn, int ci, struct pair *pp) {
  u32 a = pp->a, b = pp->b;
  return !ci || (up(lit[a]) == lit[a] && up(lit[b]) == lit[b]) ? lit_steps(s, n, from, lit, litn, ci, pp, 1)
                                                                : lit_steps(s, n, from, lit, litn, ci, pp, 0);
}
/* lit_find (below), 64 places a step, in 16-byte registers (xlat's: the browser has no AVX). */
static u64 lit_find16(const u8 *s, u64 n, u64 from, const u8 *lit, u32 litn, int ci, struct pair *pp) {
  u32 a = pp->a, b = pp->b;
  u8 f0 = lit[a], l0 = lit[b];
  u64 i = from, last = n - litn;
  int one = !ci || (up(f0) == f0 && up(l0) == l0); /* each byte one way */
  v16 F0 = splat(f0), F1 = splat(up(f0)), L0 = splat(l0), L1 = splat(up(l0));
  for (; i + 64 <= last + 1; i += 64) {
    v16 x[4];
    for (int k = 0; k < 4; k++) {
      v16 w = ld128(s + i + 16 * k + a), y = ld128(s + i + 16 * k + b);
      x[k] = one ? (w == F0) & (y == L0) : ((w == F0) | (w == F1)) & ((y == L0) | (y == L1));
    }
    if (__builtin_expect(!mask16(x[0] | x[1] | x[2] | x[3]), 1)) continue;
    u64 m = (u64)mask16(x[0]) | (u64)mask16(x[1]) << 16 | (u64)mask16(x[2]) << 32 | (u64)mask16(x[3]) << 48;
    for (; m; m &= m - 1) {
      u64 q = i + (u32)__builtin_ctzll(m);
      if (ci ? eqi(s + q, lit, litn) : eq(s + q, lit, litn)) return q;
      if (pair_poor(pp, q - from)) { pp->stop = i; return n; }
    }
  }
  for (; i <= last; i++)
    if ((s[i + a] == f0 || (ci && up(s[i + a]) == up(f0))) && (ci ? eqi(s + i, lit, litn) : eq(s + i, lit, litn))) return i;
  return n;
}
static u64 lit_find(const u8 *s, u64 n, u64 from, const u8 *lit, u32 litn, int ci, struct pair *pp) {
  for (;;) {
    if (litn > n || from > n - litn) return n;
    pp->stop = ~0ull;
    u64 q = avx2 ? lit_find_avx2(s, n, from, lit, litn, ci, pp) : lit_find16(s, n, from, lit, litn, ci, pp);
    if (pp->stop == ~0ull) { pp->seen += q - from; return q; }
    pair_change(pp, s, pp->stop, lit, litn, ci);
    from = pp->stop;
  }
}

/* The Pike machine's lists: the states live now, each once, in the order of their priority (sparse sets), and its
 * stack. Each DFA has its own (dfa.c), so threads each with their own DFAs run it at once. */
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
