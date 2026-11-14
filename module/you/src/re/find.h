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
 * the text is then looked at 64 bytes a step. sods (the browser) says it has no AVX: there the 16-byte way. Asked once,
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
/* lit_find (below), 64 places a step, in 16-byte registers (sods': the browser has no AVX). */
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

/*
 * Where one of a few literals may begin in s[i..n) (re prefixes: what every match of an alternation of words begins
 * with): the first place that holds, for some one of them, its bytes at the two places they are looked for by (a and
 * b, the same two for all: the text's bytes there are loaded once, and each literal is two compares of them and an
 * AND, the literals ORed), and then the whole of one of them. 64 places a step, or 32 in 16-byte registers; n when
 * there is none. What it gives is a place to ask the automaton at, not a match.
 *
 * By hand, for k literals in 32-byte registers: four loads, 4k compares, 2k ANDs and 2k ORs, one mask and its
 * test, and the step: 8k + 9 instructions for 64 bytes, 0.52 a byte for three. A letter in either case is one OR
 * more for each of its compares (the text's byte made small first).
 */
struct any { u32 n, a, b, len; int fold; u8 A[8][32], B[8][32], FA[8][32], FB[8][32]; };
static void any_init(struct any *y, const struct re *r) {
  /* (As many as the loops are made for: 1, 2, 4 or 8, the first one again in the places left over.) */
  u32 n = r->npre <= 2 ? r->npre : r->npre <= 4 ? 4 : 8;
  y->n = n, y->a = r->prepair[0], y->b = r->prepair[1], y->len = r->prelen, y->fold = 0;
  for (u32 k = 0; k < n; k++) {
    u32 from = k < r->npre ? k : 0;
    memset(y->A[k], r->pre[from][y->a], 32), memset(y->B[k], r->pre[from][y->b], 32);
    memset(y->FA[k], r->prefold[from][y->a], 32), memset(y->FB[k], r->prefold[from][y->b], 32);
    y->fold |= r->prefold[from][y->a] | r->prefold[from][y->b];
  }
}
/* Whether one of the literals is at s[i..n), whole: what a place any_find gives is asked before the automaton is (two
 * bytes of a literal are often there without it, and across a line's end, where the automaton would be asked of both
 * lines for nothing). */
static int any_at(const struct re *r, const u8 *s, u64 n, u64 i) {
  if (i + r->prelen > n) return 0;
  for (u32 k = 0; k < r->npre; k++) {
    u32 j = 0;
    while (j < r->prelen && (s[i + j] | r->prefold[k][j]) == r->pre[k][j]) j++;
    if (j == r->prelen) return 1;
  }
  return 0;
}
/* The first of a step's places (those of `m`'s bits, from i) that holds one of the literals, or n. Out of the steps'
 * way: a step that finds nothing, which is most of them, is its compares and no more. */
__attribute__((noinline)) static u64 any_among(const struct re *r, const u8 *s, u64 n, u64 i, u64 m) {
  for (; m; m &= m - 1) {
    u64 q = i + (u32)__builtin_ctzll(m);
    if (any_at(r, s, n, q)) return q;
  }
  return n;
}
/* The places past the last whole step, one at a time. */
static u64 any_last(const struct any *y, const struct re *r, const u8 *s, u64 n, u64 i) {
  for (; i + y->len <= n; i++) if (any_at(r, s, n, i)) return i;
  return n;
}
/* any_find's steps for k literals, `fold` or not: both constants where it is called, so each is a loop of its own with
 * its literals' compares one after another and nothing counted. */
__attribute__((target("avx2"), always_inline)) static inline u64 any_steps32(const struct any *y, const struct re *r, const u8 *s, u64 n, u64 i, const u32 k, const int fold) {
  u32 a = y->a, b = y->b;
  for (; i + 64 + b <= n; i += 64) {
    v32 a0 = ld256(s + i + a), b0 = ld256(s + i + b), a1 = ld256(s + i + 32 + a), b1 = ld256(s + i + 32 + b);
    v32 x0 = (v32){0}, x1 = (v32){0};
#pragma GCC unroll 8
    for (u32 j = 0; j < k; j++) {
      v32 A = ld256(y->A[j]), B = ld256(y->B[j]);
      if (fold) {
        v32 FA = ld256(y->FA[j]), FB = ld256(y->FB[j]);
        x0 |= ((a0 | FA) == A) & ((b0 | FB) == B), x1 |= ((a1 | FA) == A) & ((b1 | FB) == B);
      } else x0 |= (a0 == A) & (b0 == B), x1 |= (a1 == A) & (b1 == B);
    }
    /* (Each place of the step where two bytes are is asked of the literals there: the step is not made again for it.) */
    u64 m = two32(x0, x1), q;
    if (__builtin_expect(m != 0, 0) && (q = any_among(r, s, n, i, m)) != n) return q;
  }
  return any_last(y, r, s, n, i);
}
__attribute__((target("avx2"))) static u64 any_find32(const struct any *y, const struct re *r, const u8 *s, u64 n, u64 i) {
  if (y->fold) return y->n == 1 ? any_steps32(y, r, s, n, i, 1, 1) : y->n == 2 ? any_steps32(y, r, s, n, i, 2, 1) : y->n == 4 ? any_steps32(y, r, s, n, i, 4, 1) : any_steps32(y, r, s, n, i, 8, 1);
  return y->n == 1 ? any_steps32(y, r, s, n, i, 1, 0) : y->n == 2 ? any_steps32(y, r, s, n, i, 2, 0) : y->n == 4 ? any_steps32(y, r, s, n, i, 4, 0) : any_steps32(y, r, s, n, i, 8, 0);
}
__attribute__((always_inline)) static inline u64 any_steps16(const struct any *y, const struct re *r, const u8 *s, u64 n, u64 i, const u32 k, const int fold) {
  u32 a = y->a, b = y->b;
  for (; i + 32 + b <= n; i += 32) {
    v16 a0 = ld128(s + i + a), b0 = ld128(s + i + b), a1 = ld128(s + i + 16 + a), b1 = ld128(s + i + 16 + b);
    v16 x0 = (v16){0}, x1 = (v16){0};
#pragma GCC unroll 8
    for (u32 j = 0; j < k; j++) {
      v16 A = ld128(y->A[j]), B = ld128(y->B[j]);
      if (fold) {
        v16 FA = ld128(y->FA[j]), FB = ld128(y->FB[j]);
        x0 |= ((a0 | FA) == A) & ((b0 | FB) == B), x1 |= ((a1 | FA) == A) & ((b1 | FB) == B);
      } else x0 |= (a0 == A) & (b0 == B), x1 |= (a1 == A) & (b1 == B);
    }
    u64 m = mask16(x0) | mask16(x1) << 16, q;
    if (__builtin_expect(m != 0, 0) && (q = any_among(r, s, n, i, m)) != n) return q;
  }
  return any_last(y, r, s, n, i);
}
static u64 any_find(const struct any *y, const struct re *r, const u8 *s, u64 n, u64 i) {
  if (avx2) return any_find32(y, r, s, n, i);
  if (y->fold) return y->n == 1 ? any_steps16(y, r, s, n, i, 1, 1) : y->n == 2 ? any_steps16(y, r, s, n, i, 2, 1) : y->n == 4 ? any_steps16(y, r, s, n, i, 4, 1) : any_steps16(y, r, s, n, i, 8, 1);
  return y->n == 1 ? any_steps16(y, r, s, n, i, 1, 0) : y->n == 2 ? any_steps16(y, r, s, n, i, 2, 0) : y->n == 4 ? any_steps16(y, r, s, n, i, 4, 0) : any_steps16(y, r, s, n, i, 8, 0);
}
