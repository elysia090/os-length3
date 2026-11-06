/*
 * you's regular expressions, as fd and rg read them (Rust's regex crate's syntax): literals and escapes, ., classes
 * ([a-z], [^…], \d \w \s and their negations, [[:alpha:]] and the other POSIX names), groups ((…), (?:…), (?i)…),
 * alternation, the quantifiers *, +, ?, {n}, {n,}, {n,m} and their lazy forms, and the assertions ^, $, \A, \z, \b, \B.
 * Text is UTF-8: . and a negated class take a whole character, and a class may hold characters past ASCII. Not here, as
 * not in Rust's crate either: back-references and look-around.
 *
 * Compiled to a Thompson automaton over bytes and run as a Pike machine: every place a match may start is tried in
 * one pass over the text, each state at most once a byte, so no pattern takes more than the text's length times its
 * own; leftmost-first, as Rust's crate finds a match. Before it, what every match must hold: a pattern that is only a
 * literal is found by the literal alone, a word at a time, and one that holds a literal is run only where it is.
 *
 * Where it differs from Rust's crate (said, not hidden): \w, \b and case-insensitivity know ASCII's letters and take
 * every character past ASCII as a word's; a negated class that names characters past ASCII still takes them.
 */

enum { RE_ICASE = 1, RE_MULTILINE = 2 };

/* A state: one byte of a set (SET), a choice of two (SPLIT, `out` first), a jump (JUMP), an assertion (ASSERT),
 * or the match (MATCH). */
enum { S_SET, S_SPLIT, S_JUMP, S_ASSERT, S_MATCH };
enum { A_BOL, A_EOL, A_BOT, A_EOT, A_WORD, A_NOTWORD };
struct rstate { u8 op, a; u16 set; u32 out, out1; };
/* A fragment as it is built: its first state and the list of its dangling exits (each an out to patch, threaded
 * through the outs themselves: the patch list). */
struct frag { u32 start, hole; };

struct re {
  struct rstate *st;
  u32 n, cap;
  u64 *sets; /* 256 bits each */
  u32 nsets, setcap;
  u32 start;
  /* What every match must hold, and whether the pattern is that literal and nothing more (then case aside or not). */
  u8 *lit;
  u32 litn;
  int only_lit, icase;
};

static const char *re_error;
static const u8 *rp, *rend;
static struct re *R;
static int icase, multiline;

static u32 state(u8 op, u8 a, u16 set, u32 out, u32 out1) {
  if (R->n == R->cap) {
    struct rstate *m = (struct rstate *)grab(sizeof *m * R->cap * 2);
    memcpy(m, R->st, sizeof *m * R->n);
    R->st = m, R->cap *= 2;
  }
  R->st[R->n] = (struct rstate){op, a, set, out, out1};
  return R->n++;
}
static u16 newset(void) {
  if (R->nsets == R->setcap) {
    u64 *m = (u64 *)grab(32 * R->setcap * 2);
    memcpy(m, R->sets, 32 * R->nsets);
    R->sets = m, R->setcap *= 2;
  }
  memset(R->sets + 4 * R->nsets, 0, 32);
  return (u16)R->nsets++;
}
static void set_add(u16 s, u32 lo, u32 hi) {
  u64 *b = R->sets + 4 * s;
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
/* A byte range as a fragment. */
static struct frag range(u32 lo, u32 hi) {
  u16 s = newset();
  set_add(s, lo, hi);
  return one(S_SET, 0, s);
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

/* ---- Characters past ASCII: a range of code points as the UTF-8 byte sequences that spell them (split until each
 * piece is the same length, and each of its bytes a range of its own). */

static u32 utf8_len(u32 c) { return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
static void utf8_put(u32 c, u8 *o) {
  u32 n = utf8_len(c);
  if (n == 1) { o[0] = (u8)c; return; }
  for (u32 i = n - 1; i > 0; i--) o[i] = (u8)(0x80 | (c & 0x3f)), c >>= 6;
  o[0] = (u8)((n == 2 ? 0xc0 : n == 3 ? 0xe0 : 0xf0) | c);
}
static struct frag utf8_range(u32 lo, u32 hi) {
  if (lo > hi) return NONE;
  if (utf8_len(lo) != utf8_len(hi)) {
    u32 edge = utf8_len(lo) == 1 ? 0x7f : utf8_len(lo) == 2 ? 0x7ff : 0xffff;
    return alt(utf8_range(lo, edge), utf8_range(edge + 1, hi));
  }
  u32 n = utf8_len(lo);
  if (n == 1) return range(lo, hi);
  /* Split where a trailing byte would wrap: each piece then varies only in a suffix of whole ranges. */
  for (u32 i = 1; i < n; i++) {
    u32 m = (1u << (6 * i)) - 1;
    if ((lo & ~m) != (hi & ~m)) {
      if (lo & m) return alt(utf8_range(lo, lo | m), utf8_range((lo | m) + 1, hi));
      if ((hi & m) != m) return alt(utf8_range(lo, (hi & ~m) - 1), utf8_range(hi & ~m, hi));
    }
  }
  u8 a[4], b[4];
  utf8_put(lo, a), utf8_put(hi, b);
  struct frag f = NONE;
  for (u32 i = 0; i < n; i++) f = cat(f, range(a[i], b[i]));
  return f;
}
/* Any one character past ASCII (a well-formed sequence's lead byte and its continuations). */
static struct frag any_wide(void) { return utf8_range(0x80, 0x10ffff); }

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

/* A class being made: its ASCII part (a set) and its ranges past ASCII. */
struct cls { u16 set; u32 wide[64][2]; u32 nwide; int any_wide; };
static void cls_add(struct cls *k, u32 lo, u32 hi) {
  if (lo < 0x80) set_add(k->set, lo, hi < 0x80 ? hi : 0x7f);
  if (icase)
    for (u32 c = lo; c <= hi && c < 0x80; c++) {
      if (c >= 'a' && c <= 'z') set_add(k->set, c - 32, c - 32);
      else if (c >= 'A' && c <= 'Z') set_add(k->set, c + 32, c + 32);
    }
  if (hi >= 0x80 && k->nwide < 64) k->wide[k->nwide][0] = lo < 0x80 ? 0x80 : lo, k->wide[k->nwide++][1] = hi;
}
/* \d \w \s and the POSIX names, ASCII's (a word's characters past ASCII: any_wide). */
static void cls_named(struct cls *k, u8 name, int neg) {
  u16 t = newset();
  struct cls tmp = {t, {{0}}, 0, 0};
  int wide = 0;
  switch (name) {
    case 'd': cls_add(&tmp, '0', '9'); break;
    case 's': cls_add(&tmp, '\t', '\r'); cls_add(&tmp, ' ', ' '); break;
    case 'w': cls_add(&tmp, '0', '9'); cls_add(&tmp, 'A', 'Z'); cls_add(&tmp, 'a', 'z'); cls_add(&tmp, '_', '_'); wide = 1; break;
  }
  const u64 *b = R->sets + 4 * t;
  for (u32 c = 0; c < 0x80; c++) if (set_has(b, (u8)c) != neg) set_add(k->set, c, c);
  if (wide != neg) k->any_wide = 1;
}
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
    u16 t = newset();
    struct cls tmp = {t, {{0}}, 0, 0};
    switch (which) {
      case 0: cls_add(&tmp, '0', '9'); cls_add(&tmp, 'a', 'z'); cls_add(&tmp, 'A', 'Z'); break;
      case 1: cls_add(&tmp, 'a', 'z'); cls_add(&tmp, 'A', 'Z'); break;
      case 2: cls_add(&tmp, 0, 0x7f); break;
      case 3: cls_add(&tmp, ' ', ' '); cls_add(&tmp, '\t', '\t'); break;
      case 4: cls_add(&tmp, 0, 0x1f); cls_add(&tmp, 0x7f, 0x7f); break;
      case 5: cls_add(&tmp, '0', '9'); break;
      case 6: cls_add(&tmp, '!', '~'); break;
      case 7: cls_add(&tmp, 'a', 'z'); break;
      case 8: cls_add(&tmp, ' ', '~'); break;
      case 9: cls_add(&tmp, '!', '/'); cls_add(&tmp, ':', '@'); cls_add(&tmp, '[', '`'); cls_add(&tmp, '{', '~'); break;
      case 10: cls_add(&tmp, '\t', '\r'); cls_add(&tmp, ' ', ' '); break;
      case 11: cls_add(&tmp, 'A', 'Z'); break;
      case 12: cls_add(&tmp, '0', '9'); cls_add(&tmp, 'a', 'z'); cls_add(&tmp, 'A', 'Z'); cls_add(&tmp, '_', '_'); break;
      case 13: cls_add(&tmp, '0', '9'); cls_add(&tmp, 'a', 'f'); cls_add(&tmp, 'A', 'F'); break;
    }
    const u64 *b = R->sets + 4 * t;
    for (u32 c = 0; c < 0x80; c++) if (set_has(b, (u8)c) != neg) set_add(k->set, c, c);
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
    case 'x': {
      u32 v = 0, n = 0, brace = more() && *rp == '{';
      if (brace) rp++;
      while (more() && (brace || n < 2)) {
        u8 h = *rp;
        u32 d = h >= '0' && h <= '9' ? h - '0' : (h | 0x20) >= 'a' && (h | 0x20) <= 'f' ? (h | 0x20) - 'a' + 10 : 99;
        if (d == 99) break;
        v = v * 16 + d, rp++, n++;
      }
      if (brace) { if (more() && *rp == '}') rp++; else bad("\\x{ not closed"); }
      if (!n) bad("\\x without digits");
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

static struct frag from_cls(struct cls *k) {
  struct frag f = one(S_SET, 0, k->set);
  if (k->any_wide) return alt(f, any_wide());
  for (u32 i = 0; i < k->nwide; i++) f = alt(f, utf8_range(k->wide[i][0], k->wide[i][1]));
  return f;
}

static struct frag bracket(void) {
  struct cls k = {newset(), {{0}}, 0, 0};
  int neg = more() && *rp == '^';
  if (neg) rp++;
  int first = 1;
  while (more() && (first || *rp != ']')) {
    first = 0;
    if (*rp == '[' && posix_named(&k)) continue;
    i64 lo;
    int named;
    if (*rp == '\\') { rp++; lo = escape(&k, &named); if (named) continue; }
    else lo = next_char();
    i64 hi = lo;
    if (rend - rp >= 2 && rp[0] == '-' && rp[1] != ']') {
      rp++;
      if (*rp == '\\') { rp++; hi = escape(0, &named); if (named) bad("a range to a class"); }
      else hi = next_char();
      if (hi < lo) bad("a range backwards");
    }
    cls_add(&k, (u32)lo, (u32)hi);
  }
  if (!more()) { bad("a [ not closed"); return NONE; }
  rp++;
  if (neg) {
    u64 *b = R->sets + 4 * k.set;
    for (int w = 0; w < 2; w++) b[w] = ~b[w];
    b[2] = b[3] = 0;
    k.any_wide = 1, k.nwide = 0;
  }
  return from_cls(&k);
}

static struct frag lit_char(u32 c) {
  if (c < 0x80) {
    struct cls k = {newset(), {{0}}, 0, 0};
    cls_add(&k, c, c);
    return one(S_SET, 0, k.set);
  }
  u8 b[4];
  utf8_put(c, b);
  struct frag f = NONE;
  for (u32 i = 0; i < utf8_len(c); i++) f = cat(f, range(b[i], b[i]));
  return f;
}

static struct frag alternation(int depth);

static struct frag atom(int depth) {
  u8 c = *rp;
  if (c == '(') {
    rp++;
    int save = icase, save_m = multiline;
    if (more() && *rp == '?') {
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
    struct frag f = alternation(depth + 1);
    if (!more() || *rp != ')') bad("a ( not closed");
    else rp++;
    icase = save, multiline = save_m;
    return f;
  }
  rp++;
  switch (c) {
    case '.': {
      struct cls k = {newset(), {{0}}, 0, 1};
      set_add(k.set, 0, 0x7f);
      R->sets[4 * k.set] &= ~(1ull << '\n');
      return from_cls(&k);
    }
    case '[': return bracket();
    case '^': return one(S_ASSERT, multiline ? A_BOL : A_BOT, 0);
    case '$': return one(S_ASSERT, multiline ? A_EOL : A_EOT, 0);
    case '\\': {
      if (more() && (*rp == 'b' || *rp == 'B' || *rp == 'A' || *rp == 'z')) {
        u8 a = *rp++;
        return one(S_ASSERT, a == 'b' ? A_WORD : a == 'B' ? A_NOTWORD : a == 'A' ? A_BOT : A_EOT, 0);
      }
      struct cls k = {newset(), {{0}}, 0, 0};
      int named;
      i64 v = escape(&k, &named);
      return named ? from_cls(&k) : lit_char((u32)v);
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
static struct frag atom_again(int depth) {
  const u8 *save = rp;
  int ic = icase, ml = multiline;
  rp = atom_at, icase = atom_icase, multiline = atom_multiline;
  struct frag f = atom(depth);
  rp = save, icase = ic, multiline = ml;
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
      atom_at = a0, atom_icase = ic, atom_multiline = ml;
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
 * top-level alternation or sets its own flags; every byte of it small when case is aside (and then no byte past ASCII,
 * whose case is not folded here). `only_lit`: the pattern is that literal and nothing else. */
/* The index after the token at i that is not a plain character: an escape (\x41, \x{…}, \d…), a class ([…], with
 * its own escapes, [:name:] and a leading ]) or a count ({n,m}); one byte for anything else. */
static u32 skip_token(const u8 *p, u32 n, u32 i) {
  if (p[i] == '\\') {
    i++;
    if (i < n && p[i] == 'x') {
      i++;
      if (i < n && p[i] == '{') { while (i < n && p[i] != '}') i++; return i + 1; }
      return i + 2 > n ? n : i + 2;
    }
    return i + 1;
  }
  if (p[i] == '[') {
    i++;
    if (i < n && p[i] == '^') i++;
    if (i < n && p[i] == ']') i++;
    while (i < n && p[i] != ']') {
      if (p[i] == '\\') i += 2;
      else if (p[i] == '[' && i + 1 < n && p[i + 1] == ':') {
        u32 j = i + 2;
        while (j + 1 < n && !(p[j] == ':' && p[j + 1] == ']')) j++;
        i = j + 2;
      } else i++;
    }
    return i + 1;
  }
  if (p[i] == '{') { while (i < n && p[i] != '}') i++; return i + 1; }
  return i + 1;
}

static void required(struct re *r, const u8 *p, u32 n) {
  int depth = 0;
  for (u32 i = 0; i < n;) {
    if (p[i] == '(' && i + 1 < n && p[i + 1] == '?') return; /* its own flags: case may differ inside */
    if (p[i] == '(') depth++;
    else if (p[i] == ')') depth--;
    else if (p[i] == '|' && !depth) return;
    else if (icase && p[i] >= 0x80) return;
    i = p[i] == '\\' || p[i] == '[' || p[i] == '{' ? skip_token(p, n, i) : i + 1;
  }
  u32 best = 0, bestat = 0, run = 0, at = 0;
  int plain_only = 1;
  depth = 0;
  for (u32 i = 0; i <= n;) {
    u8 c = i < n ? p[i] : 0;
    int meta = c == '\\' || c == '.' || c == '[' || c == '(' || c == ')' || c == '|' || c == '*' || c == '+' || c == '?' || c == '{'
      || c == '^' || c == '$';
    if (i < n && !depth && !meta) { if (!run) at = i; run++; i++; continue; }
    if (i < n) plain_only = 0;
    if (run && (c == '*' || c == '?' || c == '{')) run--; /* its last character repeated, or not there at all */
    if (run > best) best = run, bestat = at;
    run = 0;
    if (i >= n) break;
    if (c == '(') depth++;
    else if (c == ')' && depth) depth--;
    i = skip_token(p, n, i);
  }
  if (!best) return;
  r->lit = grab(best);
  r->litn = best;
  for (u32 i = 0; i < best; i++) {
    u8 c = p[bestat + i];
    r->lit[i] = icase && c >= 'A' && c <= 'Z' ? c | 0x20 : c;
  }
  r->only_lit = plain_only && best == n;
  r->icase = icase;
}

static struct re *re_compile(const u8 *pat, u32 n, int flags) {
  struct re *r = (struct re *)grab(sizeof *r);
  memset(r, 0, sizeof *r);
  r->cap = 64, r->st = (struct rstate *)grab(sizeof *r->st * 64);
  r->setcap = 16, r->sets = (u64 *)grab(32 * 16);
  R = r, re_error = 0, rp = pat, rend = pat + n, icase = flags & RE_ICASE, multiline = flags & RE_MULTILINE;
  struct frag f = alternation(0);
  if (more() && !re_error) bad("a ) not opened");
  if (re_error) return 0;
  u32 m = state(S_MATCH, 0, 0, 0, 0);
  patch(f.hole, m);
  r->start = f.start == ~0u ? m : f.start;
  icase = flags & RE_ICASE;
  required(r, pat, n);
  return r;
}

/* ---- Running it ---- */

static inline int is_word(const u8 *s, u64 n, u64 i) { return i < n && (s[i] >= 0x80 || s[i] == '_' || (u32)((s[i] | 0x20) - 'a') < 26u || (u32)(s[i] - '0') < 10u); }

/* Where a literal is in s[from..n), case aside when told (the literal small): its place, or n. */
static u64 lit_find(const u8 *s, u64 n, u64 from, const u8 *lit, u32 litn, int ci) {
  if (litn > n || from > n - litn) return n;
  u8 f0 = lit[0], f1 = ci && f0 >= 'a' && f0 <= 'z' ? f0 - 32 : f0;
  u64 w0 = f0 * ONES, w1 = f1 * ONES;
  for (u64 i = from, last = n - litn; i <= last;) {
    if (i + 8 <= last + 1) {
      u64 w = ld64(s + i), m = zeros(w ^ w0) | zeros(w ^ w1);
      if (!m) { i += 8; continue; }
      i += (u64)__builtin_ctzll(m) >> 3;
    } else if (s[i] != f0 && s[i] != f1) { i++; continue; }
    u32 k = 1;
    if (ci) while (k < litn && (s[i + k] >= 'A' && s[i + k] <= 'Z' ? s[i + k] | 0x20 : s[i + k]) == lit[k]) k++;
    else while (k < litn && s[i + k] == lit[k]) k++;
    if (k == litn) return i;
    i++;
  }
  return n;
}

/* The Pike machine's lists: the states live now, each once, in the order of their priority (sparse sets). */
static u32 *pk_dense[2], *pk_sparse[2], pk_n[2];
static u64 *pk_from[2];
static u32 pk_cap;
static int pk_has(int l, u32 s) { u32 k = pk_sparse[l][s]; return k < pk_n[l] && pk_dense[l][k] == s; }

static u32 *pk_stack;
/* Follow the epsilon edges from `s` at position i into list l, in priority order (a stack, out before out1). */
static void pk_add(struct re *r, int l, u32 s0, u64 from, const u8 *t, u64 n, u64 i) {
  u32 top = 0;
  pk_stack[top++] = s0;
  while (top) {
    u32 s = pk_stack[--top];
    if (pk_has(l, s)) continue;
    pk_sparse[l][s] = pk_n[l];
    pk_dense[l][pk_n[l]] = s;
    pk_from[l][pk_n[l]++] = from;
    struct rstate *st = &r->st[s];
    if (st->op == S_JUMP) pk_stack[top++] = st->out;
    else if (st->op == S_SPLIT) pk_stack[top++] = st->out1, pk_stack[top++] = st->out;
    else if (st->op == S_ASSERT) {
      int ok;
      switch (st->a) {
        case A_BOT: ok = i == 0; break;
        case A_EOT: ok = i == n; break;
        case A_BOL: ok = i == 0 || t[i - 1] == '\n'; break;
        case A_EOL: ok = i == n || t[i] == '\n'; break;
        default: { int w = (i && is_word(t, n, i - 1)) != is_word(t, n, i); ok = st->a == A_WORD ? w : !w; }
      }
      if (ok) pk_stack[top++] = st->out;
    }
  }
}

/* The leftmost-first match in t[from..n): 1, and where it is. Each step: a new start (lower in priority than every
 * thread before it) until a match is found; each thread, in priority order, matched (then those after it are cut off:
 * they rank below it) or taken over the byte. A thread ranked above the match goes on and may end a longer match,
 * which then stands, as leftmost-first has it. */
static int re_run(struct re *r, const u8 *t, u64 n, u64 from, u64 *ms, u64 *me) {
  if (pk_cap < r->n) {
    pk_cap = r->n;
    for (int l = 0; l < 2; l++) {
      pk_dense[l] = (u32 *)grab(4 * (u64)pk_cap), pk_sparse[l] = (u32 *)grab(4 * (u64)pk_cap);
      pk_from[l] = (u64 *)grab(8 * (u64)pk_cap);
    }
    pk_stack = (u32 *)grab(4 * (u64)pk_cap * 2 + 8);
  }
  int cur = 0, found = 0;
  pk_n[0] = 0;
  for (u64 i = from;; i++) {
    if (!found) pk_add(r, cur, r->start, i, t, n, i);
    if (!pk_n[cur]) break;
    int nx = cur ^ 1;
    pk_n[nx] = 0;
    for (u32 k = 0; k < pk_n[cur]; k++) {
      struct rstate *st = &r->st[pk_dense[cur][k]];
      if (st->op == S_MATCH) { *ms = pk_from[cur][k], *me = i, found = 1; break; }
      if (st->op == S_SET && i < n && set_has(r->sets + 4 * st->set, t[i])) pk_add(r, nx, st->out, pk_from[cur][k], t, n, i + 1);
    }
    if (i >= n) break;
    cur = nx;
  }
  return found;
}

/* The leftmost-first match of r in t[from..n) (a literal alone found as one; one that holds a literal run only from
 * the line the literal is on, when the pattern cannot cross a line). */
static int re_find(struct re *r, const u8 *t, u64 n, u64 from, u64 *ms, u64 *me) {
  if (r->only_lit) {
    u64 at = lit_find(t, n, from, r->lit, r->litn, r->icase);
    if (at == n) return 0;
    *ms = at, *me = at + r->litn;
    return 1;
  }
  if (r->litn && lit_find(t, n, from, r->lit, r->litn, r->icase) == n) return 0;
  return re_run(r, t, n, from, ms, me);
}
