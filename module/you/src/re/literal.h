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
 * (grep.h: a text's places looked at 16 or 32 bytes at a time for those that begin so, each asked of the DFA there).
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

/*
 * What every match begins with, where that is one of a few literals: every way from the start through states that
 * take one byte (or a letter in either case), as far as eight bytes, to where a way ends (a state that takes more
 * than that, the eighth byte, or the match: a match that can end before two bytes begins with nothing to look for).
 * Eight literals at most, cut to the shortest's length and each kept once. An alternation of words is found by
 * these (find.h any_find: two bytes of each, 32 places at a time), where its first bytes' ranges (firsts) take in
 * most of a text: foo|bar|baz begins with b or f, then a or o, which is every other word of code. And a word
 * between its edges by the word: each place it is at is asked of the automaton there, which reads the bytes beside
 * it and no more of the line.
 */
struct preway { struct re *r; u8 at[8], fold[8]; u8 way[64][8], wayfold[64][8], len[64]; u32 ways, least, most; u8 *on; u32 steps; int bad; };
static void pre_end(struct preway *w, u32 d) {
  if (d < 2) { w->bad = 1; return; }
  /* (The same one by another way, a class after it that is many states: once.) */
  for (u32 k = 0; k < w->ways; k++)
    if (w->len[k] == d && eq(w->way[k], w->at, d) && eq(w->wayfold[k], w->fold, d)) return;
  if (w->ways == 64) { w->bad = 1; return; }
  memcpy(w->way[w->ways], w->at, 8), memcpy(w->wayfold[w->ways], w->fold, 8), w->len[w->ways] = (u8)d;
  if (!w->ways || d < w->least) w->least = d;
  w->ways++;
}
static void pre_walk(struct preway *w, u32 v, u32 d) {
  struct re *r = w->r;
  /* (A way round with no byte read comes back to a state it is at: left there. And a pattern with ways without end.) */
  if (w->bad || w->on[v] == d + 1 || ++w->steps > 4096) { w->bad |= w->steps > 4096; return; }
  u8 was = w->on[v];
  w->on[v] = (u8)(d + 1);
  struct rstate *st = &r->st[v];
  if (st->op == S_MATCH) pre_end(w, d);
  else if (st->op == S_SPLIT) pre_walk(w, st->out, d), pre_walk(w, st->out1, d);
  else if (st->op != S_SET) pre_walk(w, st->out, d); /* a jump, an assertion, a group's edge */
  else {
    /* The one byte it takes, or the two that are a letter's cases; else the way ends before it. */
    const u64 *b = r->sets + 4 * st->set;
    u32 n = 0, c[2] = {0, 0};
    for (u32 x = 0; x < 256 && n <= 2; x++)
      if (b[x >> 6] >> (x & 63) & 1) { if (n < 2) c[n] = x; n++; }
    int letter = n == 2 && c[1] == c[0] + 32 && c[0] >= 'A' && c[0] <= 'Z';
    if (n != 1 && !letter) pre_end(w, d);
    else {
      w->at[d] = (u8)(letter ? c[1] : c[0]), w->fold[d] = letter ? 0x20 : 0;
      if (d + 1 == w->most) pre_end(w, d + 1); else pre_walk(w, st->out, d + 1);
    }
  }
  w->on[v] = was;
}
static void prefixes(struct re *r) {
  static struct preway w; /* (its ways are 1 KiB: not on the stack of a walk that is itself deep) */
  u8 *on = grab(r->n);
  r->npre = r->prelen = 0;
  /* As far as eight bytes, or as far as leaves them few: a class after a word is many ways on from it (\d is every
   * script's digits, each its own bytes), all of them that word where the ways are cut at its end. */
  for (u32 most = 8; most >= 2 && !r->npre; most--) {
    memset(&w, 0, sizeof w), memset(on, 0, r->n);
    w.r = r, w.on = on, w.most = most;
    pre_walk(&w, r->start, 0);
    if (w.bad && w.ways < 64 && w.steps <= 4096) return; /* (a match of under two bytes: no shorter cut has fewer) */
    if (w.bad) continue;
    /* Each once, as far as the shortest goes; eight at most. (One alone is what a pattern begins with behind a
     * word's edge or in a group of its own, \bfor\b and -w's \b(?:for)\b: where a match begins is then known,
     * and asked there, not of the whole line.) */
    u32 n = 0, many = 0;
    for (u32 k = 0; k < w.ways && !many; k++) {
      u32 same = 0;
      for (u32 h = 0; h < n && !same; h++) same = eq(r->pre[h], w.way[k], w.least) && eq(r->prefold[h], w.wayfold[k], w.least);
      if (same) continue;
      if (n == 8) { many = 1; break; }
      memcpy(r->pre[n], w.way[k], 8), memcpy(r->prefold[n], w.wayfold[k], 8), n++;
    }
    if (many) continue;
    r->npre = n, r->prelen = w.least;
  }
  if (!r->npre) return;
  /* The two places they are looked for by: where the bytes all of them hold there are rarest together. */
  u64 least = ~0ull;
  for (u32 a = 0; a < r->prelen; a++)
    for (u32 b = a + 1; b < r->prelen; b++) {
      u64 often = 0;
      for (u32 k = 0; k < r->npre; k++) often += (u64)(rarity(r->pre[k][a], r->prefold[k][a]) + 1) * (rarity(r->pre[k][b], r->prefold[k][b]) + 1);
      if (often < least) least = often, r->prepair[0] = a, r->prepair[1] = b;
    }
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
  prefixes(r);
  return r;
}
