/*
 * regex.c's automaton as a DFA made as it is run (lazily, as RE2's and Rust's crate's are): a state is a set of the
 * automaton's states not yet followed through their empty edges, with what the byte before was (a line's start, a
 * word's character) where the pattern asks; each of its moves, on a class of bytes the pattern does not tell apart, is
 * worked out the first time it is taken and kept. A move also says whether a match ended before its byte. So a text is
 * run a byte at a time, each byte two loads and a test, whatever the pattern.
 *
 * Three ways, each its own DFA:
 *   D_LINES  which lines hold a match: unanchored (the pattern's start taken again at every byte), the states sets.
 *            Run four lines' stretches at once (four lanes, each its own state), as one byte's move waits on the one
 *            before it but four lanes' do not.
 *   D_FWD    where the leftmost-first match ends: the states in order of priority, the unanchored start lowest (a
 *            PREFIX entry, last), and all after a match cut off; run until no thread is left.
 *   D_ANCH   anchored: begun at one place and run as far as any thread lives. Backwards (re_reverse), from where a
 *            match ends: the furthest back it matched is where the match begins. Forwards, from where a literal the
 *            pattern begins with is: whether a match begins there.
 *
 * Empty-width assertions are decided when the byte after is known (as RE2 does): ^ by the state's flags, $ by the byte
 * (or the end), \b by the flag and the byte. A \b beside a character past ASCII asks for Unicode's \w, which a byte
 * does not say: a pattern with \b quits on such a byte, and the caller asks the Pike machine. Lines: no class holds
 * \n (RE_LINES), so the move on \n is to the state of a line's start.
 *
 * Kept: as many states as DFA_ROOM bytes of moves hold; past that, all are forgotten and made again from where the run
 * is (what the lanes hold is kept).
 */

#define DFA_ROOM (1u << 21) /* bytes of moves, and as many of states' sets */
#define T_UNKNOWN 0x10000000u /* not worked out (the table is filled with 0x10 bytes) */
#define T_QUIT 0x20000000u    /* a byte past ASCII where a \b may be asked: the DFA cannot say */
#define T_DEAD 0x40000000u    /* to the state of no thread: nothing more will match */
#define T_MATCH 0x80000000u   /* a match ended before this byte */
#define T_ROW 0x0fffffffu
#define T_SLOW T_UNKNOWN /* a move at or past it is one of the above */

enum { D_LINES, D_FWD, D_ANCH };
enum { F_BOT = 1, F_BOL = 2, F_WORD = 4 };

struct dfa {
  struct re *r;
  int mode, quit;
  u32 need; /* the flags the pattern asks about */
  u8 cls[256], rep[256];
  u32 ncls, hicls;
  u32 *trans, max, n; /* a row of ncls moves a state; row 0 is the dead state */
  u32 *setat, *setn, *pool, pooln, pooltop;
  u8 *flags;
  u32 *hash, hmask;
  u32 starts[8]; /* each flags' start (row + 1), 0 when not made */
  u32 *scratch, *next, *mark, gen, *stack, prefix;
  u32 *saved; /* the sets of the rows kept while room is made (five at most) */
};

static int byte_word(u8 b) { return b == '_' || (u32)((b | 0x20) - 'a') < 26u || (u32)(b - '0') < 10u; }

/* Split each class by whether its bytes are in `in` (bytes past ASCII kept whole when they quit). */
static u32 refine(u8 *c, u32 n, const u64 *in, int keep_high) {
  u16 to_in[256], to_out[256];
  for (u32 i = 0; i < n; i++) to_in[i] = to_out[i] = 0xffff;
  u32 m = 0;
  for (u32 b = 0; b < 256; b++) {
    u16 *t = set_has(in, (u8)b) && !(keep_high && b >= 0x80) ? to_in : to_out;
    if (t[c[b]] == 0xffff) t[c[b]] = (u16)m++;
    c[b] = (u8)t[c[b]];
  }
  return m;
}
/* The classes: bytes in the same sets, alike as words' characters and as \n, are one (refined set by set). */
static void dfa_classes(struct dfa *d) {
  struct re *r = d->r;
  u32 n = 1;
  memset(d->cls, 0, 256);
  u64 b[4] = {0};
  if (d->quit) { bits_add(b, 0x80, 0xff); n = refine(d->cls, n, b, 0); }
  memset(b, 0, 32), bits_add(b, '\n', '\n'), n = refine(d->cls, n, b, d->quit);
  if (r->has_word) {
    memset(b, 0, 32);
    for (u32 x = 0; x < 128; x++) if (byte_word((u8)x)) bits_add(b, x, x);
    n = refine(d->cls, n, b, d->quit);
  }
  for (u32 s = 0; s < r->nsets; s++) n = refine(d->cls, n, r->sets + 4 * s, d->quit);
  d->ncls = n;
  for (u32 x = 256; x-- > 0;) d->rep[d->cls[x]] = (u8)x;
  d->hicls = d->quit ? d->cls[0x80] : ~0u;
}

/* The automaton's states reached from `in` through empty edges (and from the start, in D_LINES), assertions decided by
 * the flags before and the byte after (`next`, or -1 at the end): the byte's states and the match, into scratch, in
 * order of priority (each from the first way that reaches it; PREFIX: the start there, and PREFIX after it). */
static u32 dfa_closure(struct dfa *d, const u32 *in, u32 n, u32 flags, int next) {
  struct re *r = d->r;
  u32 out = 0, g = ++d->gen;
  if (!g) { memset(d->mark, 0, 4 * (u64)r->n); g = d->gen = 1; }
  int nword = next >= 0 && byte_word((u8)next), nnl = next < 0 || next == '\n';
  for (u32 k = 0; k <= n; k++) {
    u32 top = 0;
    if (k < n && in[k] != d->prefix) d->stack[top++] = in[k];
    else if (k < n || d->mode == D_LINES) d->stack[top++] = r->start;
    else break;
    while (top) {
      u32 s = d->stack[--top];
      if (d->mark[s] == g) continue;
      d->mark[s] = g;
      struct rstate *st = &r->st[s];
      switch (st->op) {
        case S_JUMP: d->stack[top++] = st->out; break;
        case S_SPLIT: d->stack[top++] = st->out1; d->stack[top++] = st->out; break;
        case S_ASSERT: {
          int ok;
          switch (st->a) {
            case A_BOT: ok = flags & F_BOT; break;
            case A_BOL: ok = flags & F_BOL; break;
            case A_EOT: ok = next < 0; break;
            case A_EOL: ok = nnl; break;
            default: ok = (!!(flags & F_WORD) != nword) == (st->a == A_WORD);
          }
          if (ok) d->stack[top++] = st->out;
          break;
        }
        default: d->scratch[out++] = s; /* a byte's state, or the match */
      }
    }
    if (k < n && in[k] == d->prefix) d->scratch[out++] = d->prefix;
  }
  return out;
}

static void dfa_forget(struct dfa *d) {
  d->n = 1, d->pooltop = 0;
  memset(d->hash, 0, 4 * ((u64)d->hmask + 1));
  memset(d->starts, 0, sizeof d->starts);
}

/* The state of these automaton states (put in order when order does not matter, so one set is one state) and flags:
 * found, or made; ~0 when there is no room. */
static u32 dfa_state(struct dfa *d, u32 *s, u32 n, u32 flags) {
  if (d->mode != D_FWD)
    for (u32 i = 1; i < n; i++) {
      u32 x = s[i], j = i;
      for (; j && s[j - 1] > x; j--) s[j] = s[j - 1];
      s[j] = x;
    }
  u32 h = 2166136261u ^ flags;
  for (u32 i = 0; i < n; i++) h = (h ^ s[i]) * 16777619u;
  for (h &= d->hmask;; h = (h + 1) & d->hmask) {
    u32 k = d->hash[h];
    if (!k) break;
    k--;
    if (d->setn[k] == n && d->flags[k] == flags && !memcmp(d->pool + d->setat[k], s, 4 * (u64)n)) return k;
  }
  if (d->n == d->max || d->pooltop + n > d->pooln) return ~0u;
  u32 k = d->n++;
  d->setat[k] = d->pooltop, d->setn[k] = n, d->flags[k] = (u8)flags;
  memcpy(d->pool + d->pooltop, s, 4 * (u64)n);
  d->pooltop += n;
  memset(d->trans + (u64)k * d->ncls, 0x10, 4 * (u64)d->ncls);
  d->hash[h] = k + 1;
  return k;
}

/* Room made: every state forgotten, but those of the rows in keep[] (made again: their rows written back). */
static void dfa_room(struct dfa *d, u32 *keep, u32 nkeep) {
  u32 *saved = d->saved, at = 0, fl[10];
  for (u32 j = 0; j < nkeep; j++) {
    u32 k = keep[j] / d->ncls;
    fl[2 * j] = d->setn[k], fl[2 * j + 1] = d->flags[k];
    memcpy(saved + at, d->pool + d->setat[k], 4 * (u64)d->setn[k]);
    at += d->setn[k];
  }
  dfa_forget(d);
  for (u32 j = 0, from = 0; j < nkeep; j++) {
    keep[j] = dfa_state(d, saved + from, fl[2 * j], fl[2 * j + 1]) * d->ncls;
    from += fl[2 * j];
  }
}

/* The move of the state at `row` on class c, worked out and kept: its target's row and what it says (T_*). keep[]: the
 * rows the caller holds, made again (and written back) when room must be made. */
static u32 dfa_move(struct dfa *d, u32 *row, u32 c, u32 *keep, u32 nkeep) {
  if (c == d->hicls) return d->trans[*row + c] = T_QUIT;
  u8 b = d->rep[c];
  for (;;) {
    u32 k = *row / d->ncls;
    u32 m = dfa_closure(d, d->pool + d->setat[k], d->setn[k], d->flags[k], b), matched = 0, nn = 0;
    u32 g = ++d->gen;
    if (!g) { memset(d->mark, 0, 4 * (u64)d->r->n); g = d->gen = 1; }
    for (u32 i = 0; i < m; i++) {
      u32 s = d->scratch[i];
      if (s == d->prefix) { d->next[nn++] = s; continue; }
      struct rstate *st = &d->r->st[s];
      if (st->op == S_MATCH) {
        matched = 1;
        if (d->mode == D_FWD) break; /* what ranks below the match is cut off */
      } else if (set_has(d->r->sets + 4 * st->set, b) && d->mark[st->out] != g) {
        d->mark[st->out] = g;
        d->next[nn++] = st->out;
      }
    }
    u32 f = ((b == '\n' ? F_BOL : 0) | (byte_word(b) ? F_WORD : 0)) & d->need, v;
    if (!nn && d->mode != D_LINES) v = T_DEAD; /* row 0 */
    else {
      u32 t = dfa_state(d, d->next, nn, f);
      if (t == ~0u) { /* no room: forget them all, keep what the caller holds, and work it out again */
        u32 hold[5];
        memcpy(hold, keep, 4 * (u64)nkeep);
        hold[nkeep] = *row;
        dfa_room(d, hold, nkeep + 1);
        memcpy(keep, hold, 4 * (u64)nkeep);
        *row = hold[nkeep];
        continue;
      }
      v = t * d->ncls;
    }
    if (matched) v |= T_MATCH;
    return d->trans[*row + c] = v;
  }
}

static struct dfa *dfa_new(struct re *r, int mode) {
  struct dfa *d = (struct dfa *)grab(sizeof *d);
  memset(d, 0, sizeof *d);
  d->r = r, d->mode = mode, d->quit = r->has_word;
  d->need = (r->has_ends ? F_BOL | F_BOT : 0) | (r->has_word ? F_WORD : 0);
  d->prefix = mode == D_FWD ? r->n : ~0u;
  dfa_classes(d);
  d->max = DFA_ROOM / 4 / d->ncls;
  if (d->max > 65536) d->max = 65536;
  u8 *block = grab(256 + 4 * (u64)d->max * d->ncls); /* the classes, then the moves (lanes_run reads both from one) */
  memcpy(block, d->cls, 256);
  d->trans = (u32 *)(block + 256);
  d->setat = (u32 *)grab(4 * (u64)d->max), d->setn = (u32 *)grab(4 * (u64)d->max), d->flags = grab(d->max);
  for (d->hmask = 1; d->hmask < 2 * d->max; d->hmask <<= 1) {}
  d->hmask--;
  d->hash = (u32 *)grab(4 * ((u64)d->hmask + 1));
  d->pooln = DFA_ROOM / 4, d->pool = (u32 *)grab(DFA_ROOM);
  u64 n = (u64)r->n + 2;
  d->scratch = (u32 *)grab(4 * n), d->mark = (u32 *)grab(4 * n), d->stack = (u32 *)grab(4 * 3 * n);
  d->next = (u32 *)grab(4 * n), d->saved = (u32 *)grab(4 * 5 * n);
  memset(d->mark, 0, 4 * n);
  dfa_forget(d);
  /* Row 0: in D_FWD and D_ANCH the dead state, its moves dead; in D_LINES a state that stays itself (a parked lane). */
  for (u32 c = 0; c < d->ncls; c++) d->trans[c] = mode == D_LINES ? 0 : T_DEAD;
  return d;
}

/* The row of the state where a run begins, by the flags of the byte before. */
static u32 dfa_start(struct dfa *d, u32 flags, u32 *keep, u32 nkeep) {
  flags &= d->need;
  if (d->starts[flags]) return d->starts[flags] - 1;
  u32 s = d->mode == D_FWD ? d->prefix : d->r->start;
  for (;;) {
    u32 k = dfa_state(d, &s, d->mode == D_LINES ? 0 : 1, flags);
    if (k != ~0u) return (d->starts[flags] = k * d->ncls + 1) - 1;
    dfa_room(d, keep, nkeep);
  }
}

/* What the move on class c from the row says, worked out if it is not yet. */
static inline u32 dfa_step(struct dfa *d, u32 *row, u32 c, u32 *keep, u32 nkeep) {
  u32 v = d->trans[*row + c];
  return v & T_UNKNOWN ? dfa_move(d, row, c, keep, nkeep) : v;
}

/* Whether the line t[ls..le) holds a match (le at its \n, or the text's end): 1, 0, or -1 when the DFA cannot say. */
static int dfa_line(struct dfa *d, const u8 *t, u64 ls, u64 le) {
  u32 row = dfa_start(d, F_BOL | F_BOT, 0, 0);
  const u32 *tr = d->trans;
  const u8 *cl = d->cls;
  for (u64 i = ls; i < le; i++) {
    u32 v = tr[row + cl[t[i]]];
    if (__builtin_expect(v >= T_SLOW, 0)) {
      v = dfa_step(d, &row, cl[t[i]], 0, 0);
      if (v & T_QUIT) return -1;
      if (v & T_MATCH) return 1;
    }
    row = v;
  }
  return !!(dfa_step(d, &row, cl['\n'], 0, 0) & T_MATCH);
}

/* Where the leftmost-first match in the line t[ls..le) that begins at x or after it ends: its end, -1 when there is
 * none, -2 when the DFA cannot say. */
static i64 dfa_fwd(struct dfa *d, const u8 *t, u64 ls, u64 le, u64 x) {
  if (x > ls && t[x - 1] >= 0x80 && d->quit) return -2;
  u32 row = dfa_start(d, x == ls ? F_BOL | F_BOT : x > ls && byte_word(t[x - 1]) ? F_WORD : 0, 0, 0);
  const u8 *cl = d->cls;
  i64 end = -1;
  for (u64 i = x; i < le; i++) {
    u32 v = d->trans[row + cl[t[i]]];
    if (v >= T_SLOW) {
      v = dfa_step(d, &row, cl[t[i]], 0, 0);
      if (v & T_QUIT) return -2;
      if (v & T_MATCH) end = (i64)i;
      if (v & T_DEAD) return end;
      v &= T_ROW;
    }
    row = v;
  }
  return dfa_step(d, &row, cl['\n'], 0, 0) & T_MATCH ? (i64)le : end;
}

/* Where the match that ends at e begins, it having begun at x or after (by the reverse DFA): its start, or -2 when the
 * DFA cannot say. */
static i64 dfa_rev(struct dfa *d, const u8 *t, u64 ls, u64 le, u64 x, u64 e) {
  if (e < le && t[e] >= 0x80 && d->quit) return -2;
  u32 row = dfa_start(d, e == le ? F_BOL | F_BOT : byte_word(t[e]) ? F_WORD : 0, 0, 0);
  const u8 *cl = d->cls;
  i64 s = -1;
  for (u64 i = e; i > x; i--) {
    u32 v = d->trans[row + cl[t[i - 1]]];
    if (v >= T_SLOW) {
      v = dfa_step(d, &row, cl[t[i - 1]], 0, 0);
      if (v & T_QUIT) return -2;
      if (v & T_MATCH) s = (i64)i;
      if (v & T_DEAD) return s;
      v &= T_ROW;
    }
    row = v;
  }
  u32 v = dfa_step(d, &row, cl[x > ls ? t[x - 1] : '\n'], 0, 0);
  if (v & T_QUIT) return -2;
  return v & T_MATCH ? (i64)x : s;
}

/* Whether a match begins at x in t[0..n) (the DFA anchored there, forwards; it dies at the line's \n, a match ending
 * there said by the move on it): 1; 0 when none does and it died before the line's end, 2 when it ran to the end
 * (another place on the line may cost as much again: the caller asks of the line once instead); -1 when the DFA
 * cannot say. */
static int dfa_at(struct dfa *d, const u8 *t, u64 n, u64 x) {
  if (x && t[x - 1] >= 0x80 && d->quit) return -1;
  u32 row = dfa_start(d, !x || t[x - 1] == '\n' ? F_BOL | F_BOT : byte_word(t[x - 1]) ? F_WORD : 0, 0, 0);
  const u8 *cl = d->cls;
  for (u64 i = x; i < n; i++) {
    u32 v = d->trans[row + cl[t[i]]];
    if (v >= T_SLOW) {
      v = dfa_step(d, &row, cl[t[i]], 0, 0);
      if (v & T_QUIT) return -1;
      if (v & T_MATCH) return 1;
      if (v & T_DEAD) return t[i] == '\n' ? 2 : 0;
    }
    row = v;
  }
  return dfa_step(d, &row, cl['\n'], 0, 0) & T_MATCH ? 1 : 2;
}

/* Where the line holding byte i starts (after the \n before it, or `from`), and where it ends (its \n, or n). */
static u64 line_start(const u8 *t, u64 from, u64 i) {
  while (i > from && t[i - 1] != '\n') i--;
  return i;
}
static u64 line_end(const u8 *t, u64 n, u64 i) {
  const v16 nl = splat('\n');
  for (; i + 16 <= n; i += 16) {
    u32 m = mask16(ld128(t + i) == nl);
    if (m) return i + (u32)__builtin_ctz(m);
  }
  while (i < n && t[i] != '\n') i++;
  return i;
}

/* The lanes' run while every move is plain: m bytes at most of each of a[0..4), from the rows in r[] (written back:
 * those before the byte that is not plain). How many bytes each took. Two steps a turn, each lane's state passed
 * between two registers (none copied), the bytes counted up to 0 from -m (no bound held), each move tested on its
 * own (no register to gather them in), the classes read 256 bytes before the moves (dfa_new puts them there: one
 * register for both). The four moves of a step wait on nothing but their own lane's last. Fourteen registers: GCC
 * spills some of what this needs to the stack, so on x86-64 it is written out. */
#if defined(__x86_64__)
__attribute__((noinline)) static u64 lanes_run(const u32 *tr, const u8 *const *a, u64 m, u32 *r) {
  register const u8 *e0 asm("r8") = a[0] + m, *e1 asm("r9") = a[1] + m, *e2 asm("r10") = a[2] + m, *e3 asm("r11") = a[3] + m;
  register u64 r0 asm("rax") = r[0], r1 asm("rbx") = r[1], r2 asm("rcx") = r[2], r3 asm("rsi") = r[3];
  register u64 v0 asm("r12"), v1 asm("r13"), v2 asm("r14"), v3 asm("r15");
  register i64 k asm("rdx") = -(i64)m;
#define STEP(e, from, to) "movzbl (%[" #e "],%[k]), %k[" #to "]\n\t"
#define CLS(to) "movzbl -256(%[tr],%[" #to "]), %k[" #to "]\n\t"
#define MOVE(from, to) "add %[" #from "], %[" #to "]\n\t" "mov (%[tr],%[" #to "],4), %k[" #to "]\n\t"
#define TEST(x, out) "cmp $0xfffffff, %k[" #x "]\n\t" "ja " #out "\n\t"
  asm volatile(
    "1:\n\t"
    STEP(e0, r0, v0) STEP(e1, r1, v1) STEP(e2, r2, v2) STEP(e3, r3, v3)
    CLS(v0) CLS(v1) CLS(v2) CLS(v3)
    MOVE(r0, v0) MOVE(r1, v1) MOVE(r2, v2) MOVE(r3, v3)
    TEST(v0, 3f) TEST(v1, 3f) TEST(v2, 3f) TEST(v3, 3f)
    "inc %[k]\n\t"
    "jz 2f\n\t"
    STEP(e0, v0, r0) STEP(e1, v1, r1) STEP(e2, v2, r2) STEP(e3, v3, r3)
    CLS(r0) CLS(r1) CLS(r2) CLS(r3)
    MOVE(v0, r0) MOVE(v1, r1) MOVE(v2, r2) MOVE(v3, r3)
    TEST(r0, 2f) TEST(r1, 2f) TEST(r2, 2f) TEST(r3, 2f)
    "inc %[k]\n\t"
    "jnz 1b\n\t"
    "jmp 3f\n"
    "2:\n\t" /* the rows are those of the step before */
    "mov %[v0], %[r0]\n\t" "mov %[v1], %[r1]\n\t" "mov %[v2], %[r2]\n\t" "mov %[v3], %[r3]\n"
    "3:"
    : [r0] "+r"(r0), [r1] "+r"(r1), [r2] "+r"(r2), [r3] "+r"(r3), [v0] "=&r"(v0), [v1] "=&r"(v1), [v2] "=&r"(v2),
      [v3] "=&r"(v3), [k] "+r"(k)
    : [tr] "D"(tr), [e0] "r"(e0), [e1] "r"(e1), [e2] "r"(e2), [e3] "r"(e3)
    : "cc", "memory");
#undef STEP
#undef CLS
#undef MOVE
#undef TEST
  r[0] = (u32)r0, r[1] = (u32)r1, r[2] = (u32)r2, r[3] = (u32)r3;
  return (u64)((i64)m + k);
}
#else
static u64 lanes_run(const u32 *tr, const u8 *const *a, u64 m, u32 *r) {
  const u8 *cl = (const u8 *)tr - 256;
  u64 k = 0;
  for (u32 r0 = r[0], r1 = r[1], r2 = r[2], r3 = r[3];; k++) {
    if (k == m) { r[0] = r0, r[1] = r1, r[2] = r2, r[3] = r3; break; }
    u32 v0 = tr[r0 + cl[a[0][k]]], v1 = tr[r1 + cl[a[1][k]]], v2 = tr[r2 + cl[a[2][k]]], v3 = tr[r3 + cl[a[3][k]]];
    if ((v0 | v1 | v2 | v3) >= T_SLOW) { r[0] = r0, r[1] = r1, r[2] = r2, r[3] = r3; break; }
    r0 = v0, r1 = v1, r2 = v2, r3 = v3;
  }
  return k;
}
#endif

/* Lanes: the lines of t[from..to) that hold a match (from at a line's start, to at one's end: after its \n, or the
 * text's end n), their starts into out[] (room for to - from) in order: four stretches of whole lines run at once,
 * each its own state; a lane whose stretch is done is parked on row 0 (in D_LINES a state that stays itself, saying
 * nothing). A line the DFA cannot say of is asked of the Pike machine. Returns how many. */
static u32 dfa_lanes(struct dfa *d, const u8 *t, u64 n, u64 from, u64 to, u64 *out) {
  u64 b[5], p[4], e[4];
  u32 row[4], got[4], live[4];
  b[0] = from, b[4] = to;
  for (u32 j = 1; j < 4; j++) {
    u64 cut = from + (to - from) * j / 4;
    b[j] = cut <= b[j - 1] ? b[j - 1] : t[cut - 1] == '\n' ? cut : line_end(t, to, cut) + 1;
    if (b[j] > to) b[j] = to;
  }
  u32 start = dfa_start(d, F_BOL | F_BOT, 0, 0);
  for (u32 j = 0; j < 4; j++) p[j] = b[j], e[j] = b[j + 1], got[j] = 0, row[j] = start, live[j] = p[j] < e[j];
  for (;;) {
    u64 m = ~0ull;
    u32 any = 4;
    for (u32 j = 0; j < 4; j++) if (live[j]) { if (e[j] - p[j] < m) m = e[j] - p[j]; any = j; }
    if (any == 4) break;
    if (m) {
      const u8 *a[4];
      u32 rs[4];
      for (u32 j = 0; j < 4; j++) a[j] = t + p[live[j] ? j : any], rs[j] = live[j] ? row[j] : 0;
      u64 k = lanes_run(d->trans, a, m, rs);
      for (u32 j = 0; j < 4; j++) if (live[j]) row[j] = rs[j], p[j] += k;
    }
    /* Each live lane a step alone: its stretch ended (its last line, if no \n ends it, seen to), or a move not plain
     * (a match: the line kept, and the lane on at the next; or a byte the DFA cannot say of). */
    for (u32 j = 0; j < 4; j++) {
      if (!live[j]) continue;
      if (p[j] == e[j]) {
        live[j] = 0;
        if (e[j] == n && t[n - 1] != '\n' && dfa_step(d, &row[j], d->cls['\n'], row, 4) & T_MATCH) out[b[j] - from + got[j]++] = line_start(t, b[j], n);
        continue;
      }
      u64 i = p[j];
      u32 v = dfa_step(d, &row[j], d->cls[t[i]], row, 4);
      if (!(v & (T_MATCH | T_QUIT))) { row[j] = v, p[j] = i + 1; continue; }
      u64 ls = line_start(t, b[j], i), le = line_end(t, e[j], i), ms, me;
      if (v & T_MATCH || re_run(d->r, t + ls, le - ls, 0, &ms, &me)) out[b[j] - from + got[j]++] = ls;
      if (le == e[j]) live[j] = 0; /* the text's last line, no \n after it: seen to */
      else p[j] = le + 1, row[j] = dfa_start(d, F_BOL | F_BOT, row, 4);
    }
  }
  u32 k = 0;
  for (u32 j = 0; j < 4; j++)
    for (u32 x = 0; x < got[j]; x++) out[k++] = out[b[j] - from + x];
  return k;
}
