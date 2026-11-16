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
