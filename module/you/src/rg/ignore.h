/* ---- Globs: * and ? (neither a slash where `slash`), [classes] (! or ^ for none of them, a-z ranges), \ before a
 * character for itself; and where `slash`, a part that is two stars for any parts at all (after a slash: all below;
 * before one: at any depth; between two: none or any between). */
static u8 low(u8 c) { return c >= 'A' && c <= 'Z' ? (u8)(c + 32) : c; }
static int glob(const u8 *g, u32 gn, const u8 *s, u32 sn, int slash, int fold) {
  u32 i = 0, j = 0;
  while (i < gn) {
    u8 c = g[i];
    if (c == '*' && slash && i + 1 < gn && g[i + 1] == '*' && (i == 0 || g[i - 1] == '/') && (i + 2 == gn || g[i + 2] == '/')) {
      if (i + 2 == gn) return 1;                                   /* (last: all below) */
      for (u32 k = j;; k++) {                                      /* (the rest here, or after any part) */
        if ((k == j || s[k - 1] == '/') && glob(g + i + 3, gn - i - 3, s + k, sn - k, slash, fold)) return 1;
        if (k == sn) return 0;
      }
    }
    if (c == '*') {
      while (i < gn && g[i] == '*') i++;
      for (u32 k = j;; k++) {
        if (glob(g + i, gn - i, s + k, sn - k, slash, fold)) return 1;
        if (k == sn || (slash && s[k] == '/')) return 0;
      }
    }
    if (j == sn) return 0;
    if (c == '?') {
      if (slash && s[j] == '/') return 0;
      i++, j++;
      continue;
    }
    if (c == '[') {
      u32 k = i + 1;
      int none = k < gn && (g[k] == '!' || g[k] == '^'), in = 0;
      if (none) k++;
      u32 first = k;
      for (; k < gn && (g[k] != ']' || k == first); k++) {
        u8 lo = g[k], hi = lo;
        if (k + 2 < gn && g[k + 1] == '-' && g[k + 2] != ']') hi = g[k + 2], k += 2;
        if ((s[j] >= lo && s[j] <= hi) || (fold && ((low(s[j]) >= lo && low(s[j]) <= hi) ||
            (s[j] >= 'a' && s[j] <= 'z' && s[j] - 32 >= lo && s[j] - 32 <= hi)))) in = 1;
      }
      if (k < gn) {
        if (in == none || (slash && s[j] == '/')) return 0;
        i = k + 1, j++;
        continue;
      }
    }
    if (c == '\\' && i + 1 < gn) c = g[++i];
    if (s[j] != c && !(fold && low(s[j]) == low(c))) return 0;
    i++, j++;
  }
  return j == sn;
}

/* ---- The walk's stack: names and rules, each directory's given back as it is done. */
#define WALK (8u << 20)
static u8 walk[WALK];
static u64 walked;
static u8 *hold(u64 n) {
  n = (n + 7) & ~7ul;
  if (walked + n > WALK) usage("a tree too deep or too wide here", 0);
  u8 *p = walk + walked;
  walked += n;
  return p;
}

/* An ignore file's line: a glob, the parts of the path it is matched with (anchored: the path below the file's
 * directory; else the name), whether only a directory is meant, and whether it lets a path back in (!). */
struct rule { const u8 *g; u32 n; u8 back, dir, anchored; };
struct rules { struct rule *r; u32 n; };
/* What a directory's ignore files say, deepest over shallowest (`up`), and where its path's part below it begins; what
 * it is (for -L: a link that leads back to it is a loop). */
struct level { struct rules file[4]; u32 nfile, at; struct level *up; int repo; u64 dev, ino; };
/* The ignore files given (--ignore-file). */
static struct rules given[16];
static u32 ngiven;

static struct rules read_rules(int dir, const char *name) {
  struct rules rs = {0, 0};
  i64 fd = sys4(SYS_openat, dir, (i64)name, O_CLOEXEC, 0);
  if (fd < 0) return rs;
  struct kstat st;
  if (sys2(SYS_fstat, fd, (i64)&st) || !IS_REG(st.mode) || st.size <= 0 || st.size > (1 << 20)) { sys1(SYS_close, fd); return rs; }
  u8 *b = hold((u64)st.size + 1);
  i64 n = sys4(SYS_pread, fd, (i64)b, st.size, 0);
  sys1(SYS_close, fd);
  if (n <= 0) return rs;
  u32 lines = 1;
  for (i64 k = 0; k < n; k++) lines += b[k] == '\n';
  rs.r = (struct rule *)hold(sizeof *rs.r * lines);
  for (u8 *p = b, *end = b + n; p < end;) {
    u8 *e = p;
    while (e < end && *e != '\n') e++;
    u8 *t = e;
    if (t > p && t[-1] == '\r') t--;
    while (t > p && t[-1] == ' ' && !(t - 1 > p && t[-2] == '\\')) t--; /* (trailing spaces, unless escaped) */
    struct rule r = {p, (u32)(t - p), 0, 0, 0};
    p = e + 1;
    if (!r.n || r.g[0] == '#') continue;
    if (r.g[0] == '!') r.back = 1, r.g++, r.n--;
    else if (r.g[0] == '\\' && r.n > 1 && (r.g[1] == '!' || r.g[1] == '#')) r.g++, r.n--;
    if (r.n && r.g[r.n - 1] == '/') r.dir = 1, r.n--;
    for (u32 k = 0; k < r.n; k++) if (r.g[k] == '/') r.anchored = 1;
    if (r.n && r.g[0] == '/') r.g++, r.n--;
    if (r.n) rs.r[rs.n++] = r;
  }
  return rs;
}

/* -1: ignored, 1: let back in, 0: none says. `path` the path from the walk's root, `name` its last part. */
static int ruled(const struct rules *rs, const u8 *rel, u32 reln, const u8 *name, u32 namen, int dir) {
  for (u32 k = rs->n; k--;) {
    const struct rule *r = &rs->r[k];
    if (r->dir && !dir) continue;
    if (r->anchored ? glob(r->g, r->n, rel, reln, 1, 0) : glob(r->g, r->n, name, namen, 1, 0)) return r->back ? 1 : -1;
  }
  return 0;
}

static int of_type(const char *globs, const u8 *name, u32 n) {
  for (const char *g = globs; *g; g += slen(g) + 1) if (glob((const u8 *)g, (u32)slen(g), name, n, 0, 0)) return 1;
  return 0;
}
/* Two names compared by their bytes (a[0..an), b[0..bn)), as their order goes. */
static int order(const char *a, u32 an, const char *b, u32 bn) {
  for (u32 i = 0; i < an && i < bn; i++) if (a[i] != b[i]) return (u8)a[i] - (u8)b[i];
  return (int)an - (int)bn;
}
/* ripgrep's own globs of the kind t[0..tn) (types.h), or null. */
static const char *own_globs(const char *t, u32 tn) {
  for (const char *k = TYPES; *k;) {
    int is = !order(k, (u32)slen(k), t, tn);
    k += slen(k) + 1;
    if (is) return k;
    while (*k) k += slen(k) + 1;
    k++;
  }
  return 0;
}
static int cleared(const char *t, u32 tn) {
  for (u32 k = 0; k < o.ntype_clear; k++) if (!order(o.type_clear[k], (u32)slen(o.type_clear[k]), t, tn)) return 1;
  return 0;
}
/* --type-add's definition d, if it is of the kind t[0..tn): its glob (or `include:` and kinds). */
static const char *added(const char *d, const char *t, u32 tn) {
  return slen(d) > tn && d[tn] == ':' && !memcmp(d, t, tn) ? d + tn + 1 : 0;
}
/* Whether `name` is of the kind t[0..tn): by what --type-add gave it (`include:` kinds, each by its own globs), then by
 * ripgrep's own unless --type-clear cleared them. -1: no such kind. */
static int of_kind(const char *t, u32 tn, const u8 *name, u32 n, int depth) {
  int known = 0;
  for (u32 k = 0; k < o.ntype_add; k++) {
    const char *g = added(o.type_add[k], t, tn);
    if (!g) continue;
    known = 1;
    if (memcmp(g, "include:", 8)) { if (glob((const u8 *)g, (u32)slen(g), name, n, 0, 0)) return 1; continue; }
    for (const char *p = g + 8; *p;) {
      const char *e = p;
      while (*e && *e != ',') e++;
      if (depth < 8 && of_kind(p, (u32)(e - p), name, n, depth + 1) > 0) return 1;
      p = *e ? e + 1 : e;
    }
  }
  const char *g = own_globs(t, tn);
  if (g && !cleared(t, tn) && of_type(g, name, n)) return 1;
  return g || known ? 0 : -1;
}
/* --type-list: each kind and its globs (ripgrep's own unless cleared, then those added), in the order of the names. */
static void list_types(void) {
  const char *last = 0, *t = TYPES;
  u32 lastn = 0;
  for (;;) {
    /* The next name: ripgrep's next, or one only added that comes before it. */
    const char *next = *t ? t : 0;
    u32 nn = next ? (u32)slen(next) : 0;
    for (u32 k = 0; k < o.ntype_add; k++) {
      const char *d = o.type_add[k];
      u32 dn = 0;
      while (d[dn] && d[dn] != ':') dn++;
      if (!d[dn] || own_globs(d, dn) || (last && order(d, dn, last, lastn) <= 0)) continue;
      if (!next || order(d, dn, next, nn) < 0) next = d, nn = dn;
    }
    if (!next) break;
    int any = 0;
    const char *own = own_globs(next, nn);
    for (const char *g = own && !cleared(next, nn) ? own : ""; *g; g += slen(g) + 1) {
      any++ ? put(", ", 2) : (put(next, nn), put(": ", 2));
      put(g, slen(g));
    }
    for (u32 k = 0; k < o.ntype_add; k++) {
      const char *g = added(o.type_add[k], next, nn);
      if (!g) continue;
      any++ ? put(", ", 2) : (put(next, nn), put(": ", 2));
      put(g, slen(g));
    }
    if (any) put("\n", 1);
    last = next, lastn = nn;
    if (next == t) {
      t += slen(t) + 1;
      while (*t) t += slen(t) + 1;
      t++;
    }
  }
}

/* The path being walked, as it is printed: the root as named (none when it is the `.` not named), each part after. */
static u8 path[4096];
static u32 pathn, shown; /* shown: where what is printed of it begins */

/* Whether the walk takes this entry: -1 no, 1 yes. */
static int taken(const struct level *at, const u8 *name, u32 n, int dir, u32 root) {
  const u8 *rel = path + root;
  u32 reln = pathn - root;
  /* -g first, over all else: the last that matches says; a path none matches is left out if one would let it in. */
  int let_in = 0;
  for (u32 k = o.nglob; k--;) {
    const u8 *g = (const u8 *)o.glob[k];
    u32 gn = (u32)slen(o.glob[k]);
    int back = gn && g[0] == '!';
    if (back) g++, gn--;
    if (!back) let_in = 1;
    int anchored = 0, only_dir = gn && g[gn - 1] == '/';
    if (only_dir) gn--;
    for (u32 i = 0; i < gn; i++) if (g[i] == '/') anchored = 1;
    if (gn && g[0] == '/') g++, gn--;
    if (only_dir && !dir) continue;
    int fold = o.iglob[k] || o.glob_ci;
    if (anchored ? glob(g, gn, rel, reln, 1, fold) : glob(g, gn, name, n, 1, fold)) {
      if (back) return -1;
      goto typed;
    }
  }
  if (let_in && !dir) return -1;
  if (!o.hidden && name[0] == '.') return -1;
  if (!o.no_ignore)
    for (const struct level *l = at; l; l = l->up)
      for (u32 f = 0; f < l->nfile; f++) {
        int r = ruled(&l->file[f], path + l->at, pathn - l->at, name, n, dir);
        if (r < 0) return -1;
        if (r > 0) goto typed;
      }
  /* Then the ignore files given (--ignore-file), under all the rest, as if at the walk's root (even with --no-ignore). */
  for (u32 f = 0; f < ngiven; f++) {
    int r = ruled(&given[f], rel, reln, name, n, dir);
    if (r < 0) return -1;
    if (r > 0) break;
  }
typed:
  if (dir) return 1;
  int typed = !o.ntype;
  for (u32 k = 0; k < o.ntype && !typed; k++) {
    if (same(o.type[k], "all")) { typed = 1; break; }
    int r = of_kind(o.type[k], (u32)slen(o.type[k]), name, n, 0);
    if (r < 0) usage("unrecognized file type: ", o.type[k]);
    typed = r > 0;
  }
  for (u32 k = 0; k < o.nuntype && typed; k++) {
    int r = of_kind(o.untype[k], (u32)slen(o.untype[k]), name, n, 0);
    if (r < 0) usage("unrecognized file type: ", o.untype[k]);
    typed = !r;
  }
  return typed ? 1 : -1;
}
