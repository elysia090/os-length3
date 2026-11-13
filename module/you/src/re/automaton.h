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
 * one), run three ways: as a DFA made as it runs (dfa.h), which says which lines hold a match, and where one ends;
 * backwards, to where it starts (re_reverse); and as a Pike machine, where the DFA cannot say (a \b beside a character
 * past ASCII). Leftmost-first, as Rust's crate finds a match. Before any of it, what every match must hold: a pattern
 * that is only a literal is found by the literal alone, and one that holds a literal is run only where it is.
 *
 * Its parts, each one thing, in the order a pattern goes through them (rg.c includes them so):
 *   automaton.h  the automaton as it is built: states, sets of bytes, fragments and their loose ends
 *   class.h      a class of characters, and the same as UTF-8 bytes (unicode.h: Unicode's tables, made by make/)
 *   parse.h      a pattern read into the automaton
 *   literal.h    what every match must hold, and what every match begins with: found before anything is run
 *   reverse.h    the automaton turned around, to find where a match begins from where it ends
 *   word.h       a word's character, before and after a place (\b where a byte does not say)
 *   find.h       a literal found in a text: its two rarest bytes looked for, 64 or 128 places a step
 *   pike.h       the automaton run a thread a state, where the DFA cannot say; and the groups of a match
 *   dfa.h        the automaton as a DFA made as it runs: a byte two loads and a test
 *   grep.h       a text searched: which of those ways finds its lines, and each match on one
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
  u8 *cls;      /* its bytes in classes, a class each set tells apart from the rest (dfa.h dfa_classes), once made */
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
