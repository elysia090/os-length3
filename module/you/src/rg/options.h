/* ---- What it was asked: ripgrep's options, each as its last mention says. */
static struct {
  const char *pat[64];
  u32 npat;
  int fixed, kase /* 0 as written, 1 aside, 2 aside unless it holds a capital (-S) */, word, whole, invert;
  int number, filename, heading, colour; /* -1: as the output is a terminal or not (filename: as one path or more) */
  int with, without, count, count_matches, only, quiet, files, column, vimgrep, nul, text, messages;
  u64 max_count, max_columns;
  int have_max_count, preview;
  u32 after, before, max_depth;
  int hidden, no_ignore;
  const char *glob[64];
  u32 nglob;
  const char *type[32], *untype[32];
  u32 ntype, nuntype;
  const char *path[256];
  u32 npath;
  /* -f's files of patterns, a line each; -r's replacement; ignore files given (--ignore-file); kinds added and cleared. */
  const char *patfile[16], *replace, *ignore_file[16], *type_add[32], *type_clear[32];
  u32 npatfile, nignore_file, ntype_add, ntype_clear;
  u8 iglob[64]; /* -g's globs given as --iglob: case aside */
  int byte_offset, trim, passthru, include_zero, binary, follow, type_list, sort_reverse, glob_ci;
  int no_vcs, no_dot, no_exclude; /* --no-ignore-vcs (.gitignore, .git/info/exclude), -dot (.ignore, .rgignore), -exclude */
  /* As given, else none: "--", ":" and "-" are chosen where they are printed (a pointer to one kept in o, set before
   * it runs, a compiler may make a pointer in its data: something to relocate). */
  const char *ctx_sep, *field_match, *field_ctx;
  int no_ctx_sep;
  u64 max_filesize;
  int have_max_filesize;
} o = {.kase = 0, .number = -1, .filename = -1, .heading = -1, .colour = -1, .messages = 1, .max_depth = ~0u};

static int tty; /* standard output is a terminal */
static int found, errors;

/* ---- What goes wrong, said as ripgrep says it: `rg: PATH: what (os error N)`. */
static const char *strerr(i64 e) {
  switch (-e) {
    case 2: return "No such file or directory";
    case 13: return "Permission denied";
    case 20: return "Not a directory";
    case 21: return "Is a directory";
    case 40: return "Too many levels of symbolic links";
    default: return "Input/output error";
  }
}
static void warn_as(const char *path, i64 e, int named) {
  errors = 1;
  if (!o.messages) return;
  flush();
  u8 m[900];
  u64 n = 0;
  char num[8];
  int k = 0;
  for (u64 v = (u64)-e; v || !k; v /= 10) num[k++] = (char)('0' + v % 10);
  const char *parts[] = {"rg: ", path, ": ", named ? "IO error for operation on " : "", named ? path : "", named ? ": " : "",
    strerr(e), " (os error "};
  for (int i = 0; i < 8; i++)
    for (const char *s = parts[i]; *s && n < sizeof m - 16; s++) m[n++] = (u8)*s;
  while (k) m[n++] = (u8)num[--k];
  m[n++] = ')', m[n++] = '\n';
  sys3(SYS_write, 2, (i64)m, (i64)n);
}
static void warn(const char *path, i64 e) { warn_as(path, e, 0); }
__attribute__((noreturn)) static void usage_then(const char *what, const char *about, const char *then) {
  flush();
  u8 m[400];
  u64 n = 0;
  const char *parts[] = {"rg: ", what, about ? about : "", then};
  for (int i = 0; i < 4; i++)
    for (const char *s = parts[i]; *s && n < sizeof m - 2; s++) m[n++] = (u8)*s;
  m[n++] = '\n';
  sys3(SYS_write, 2, (i64)m, (i64)n);
  leave(2);
}
__attribute__((noreturn)) static void usage(const char *what, const char *about) { usage_then(what, about, ""); }

/* ---- Options. A long one's value after `=` or as the next argument; short ones run together (-inC3). */
static u64 number_of(const char *s, const char *flag) {
  u64 v = 0;
  if (!*s) usage("a number is wanted after ", flag);
  for (; *s; s++) {
    if (*s < '0' || *s > '9') usage("not a number: ", flag);
    v = v * 10 + (u64)(*s - '0');
  }
  return v;
}
static int when(const char *v) {
  if (same(v, "never")) return 0;
  if (same(v, "always") || same(v, "ansi")) return 1;
  if (same(v, "auto")) return -1;
  usage("unrecognized color choice: ", v);
}
/* --max-filesize's size: a number, and K, M or G (1024's). */
static u64 size_of(const char *v) {
  u64 n = 0;
  const char *s = v;
  for (; *s >= '0' && *s <= '9'; s++) n = n * 10 + (u64)(*s - '0');
  int shift = !*s ? 0 : s[1] ? -1 : *s == 'K' ? 10 : *s == 'M' ? 20 : *s == 'G' ? 30 : -1;
  if (s == v || shift < 0)
    usage_then("error parsing flag --max-filesize: invalid size: invalid format for size '", v,
               "', which should be a non-empty sequence of digits followed by an optional 'K', 'M' or 'G' suffix");
  return n << shift;
}
/* A glob of -g (`fold`: --iglob, case aside), each alternative of its braces a glob of its own ({rs,ts}: rs, then ts). */
static void add_glob(const char *v, int fold) {
  u32 n = (u32)slen(v), lb = n, rb = n, depth = 0;
  for (u32 i = 0; i < n && rb == n; i++) {
    if (v[i] == '\\' && i + 1 < n) i++;
    else if (v[i] == '{' && !depth++) lb = i;
    else if (v[i] == '}' && depth && !--depth) rb = i;
  }
  if (rb == n) {
    if (o.nglob < 64) o.iglob[o.nglob] = (u8)fold, o.glob[o.nglob++] = v;
    return;
  }
  for (u32 a = lb + 1, i = lb + 1, d = 0; i <= rb; i++) {
    if (v[i] == '\\' && i + 1 < rb) { i++; continue; }
    if (v[i] == '{') d++;
    else if (v[i] == '}' && i < rb) d--;
    if (i < rb && (v[i] != ',' || d)) continue;
    char *g = (char *)grab(n + 1);
    memcpy(g, v, lb);
    memcpy(g + lb, v + a, i - a);
    memcpy(g + lb + (i - a), v + rb + 1, n - rb - 1);
    g[lb + (i - a) + (n - rb - 1)] = 0;
    add_glob(g, fold); /* (its other braces) */
    a = i + 1;
  }
}

/* A long option (`name` past the dashes, `v` its value if it came with `=`), its value taken from the next argument
 * where it wants one (*a moved on). */
static void longopt(const char *name, const char *v, int argc, char **argv, int *a) {
  /* (One string, not a table of pointers: the program has nothing to relocate.) */
  static const char values[] = "regexp\0max-count\0after-context\0before-context\0context\0glob\0type\0type-not\0"
    "color\0colour\0max-columns\0max-depth\0sort\0threads\0encoding\0sortr\0replace\0file\0context-separator\0"
    "field-match-separator\0field-context-separator\0max-filesize\0ignore-file\0iglob\0type-add\0type-clear\0engine\0"
    "dfa-size-limit\0regex-size-limit\0";
  int wants = 0;
  for (const char *v2 = values; *v2; v2 += slen(v2) + 1) wants |= same(name, v2);
  if (wants && !v) {
    if (*a + 1 >= argc) usage("a value is wanted after --", name);
    v = argv[++*a];
  }
  if (same(name, "regexp")) { if (o.npat < 64) o.pat[o.npat++] = v; }
  else if (same(name, "fixed-strings")) o.fixed = 1;
  else if (same(name, "no-fixed-strings")) o.fixed = 0;
  else if (same(name, "ignore-case")) o.kase = 1;
  else if (same(name, "smart-case")) o.kase = 2;
  else if (same(name, "case-sensitive")) o.kase = 0;
  else if (same(name, "word-regexp")) o.word = 1, o.whole = 0;
  else if (same(name, "line-regexp")) o.whole = 1, o.word = 0;
  else if (same(name, "invert-match")) o.invert = 1;
  else if (same(name, "line-number")) o.number = 1;
  else if (same(name, "no-line-number")) o.number = 0;
  else if (same(name, "with-filename")) o.filename = 1;
  else if (same(name, "no-filename")) o.filename = 0;
  else if (same(name, "files-with-matches")) o.with = 1, o.without = 0;
  else if (same(name, "files-without-match")) o.without = 1, o.with = 0;
  else if (same(name, "count")) o.count = 1, o.count_matches = 0;
  else if (same(name, "count-matches")) o.count_matches = 1, o.count = 0;
  else if (same(name, "only-matching")) o.only = 1;
  else if (same(name, "quiet")) o.quiet = 1;
  else if (same(name, "files")) o.files = 1;
  else if (same(name, "column")) o.column = 1;
  else if (same(name, "no-column")) o.column = 0;
  else if (same(name, "vimgrep")) o.vimgrep = 1;
  else if (same(name, "null")) o.nul = 1;
  else if (same(name, "text")) o.text = 1;
  else if (same(name, "no-messages")) o.messages = 0;
  else if (same(name, "messages")) o.messages = 1;
  else if (same(name, "heading")) o.heading = 1;
  else if (same(name, "no-heading")) o.heading = 0;
  else if (same(name, "pretty")) o.colour = 1, o.heading = 1, o.number = 1;
  else if (same(name, "hidden")) o.hidden = 1;
  else if (same(name, "no-hidden")) o.hidden = 0;
  else if (same(name, "no-ignore")) o.no_ignore = 1;
  else if (same(name, "ignore")) o.no_ignore = 0;
  else if (same(name, "max-columns-preview")) o.preview = 1;
  else if (same(name, "no-max-columns-preview")) o.preview = 0;
  else if (same(name, "max-count")) o.max_count = number_of(v, "--max-count"), o.have_max_count = 1;
  else if (same(name, "after-context")) o.after = (u32)number_of(v, "--after-context"), o.passthru = 0;
  else if (same(name, "before-context")) o.before = (u32)number_of(v, "--before-context"), o.passthru = 0;
  else if (same(name, "context")) o.after = o.before = (u32)number_of(v, "--context"), o.passthru = 0;
  else if (same(name, "glob")) add_glob(v, 0);
  else if (same(name, "iglob")) add_glob(v, 1);
  else if (same(name, "glob-case-insensitive")) o.glob_ci = 1;
  else if (same(name, "no-glob-case-insensitive")) o.glob_ci = 0;
  else if (same(name, "replace")) o.replace = v;
  else if (same(name, "file")) { if (o.npatfile < 16) o.patfile[o.npatfile++] = v; }
  else if (same(name, "byte-offset")) o.byte_offset = 1;
  else if (same(name, "no-byte-offset")) o.byte_offset = 0;
  else if (same(name, "trim")) o.trim = 1;
  else if (same(name, "no-trim")) o.trim = 0;
  else if (same(name, "passthru") || same(name, "passthrough")) o.passthru = 1;
  else if (same(name, "include-zero")) o.include_zero = 1;
  else if (same(name, "no-include-zero")) o.include_zero = 0;
  else if (same(name, "context-separator")) o.ctx_sep = v, o.no_ctx_sep = 0;
  else if (same(name, "no-context-separator")) o.no_ctx_sep = 1;
  else if (same(name, "field-match-separator")) o.field_match = v;
  else if (same(name, "field-context-separator")) o.field_ctx = v;
  else if (same(name, "max-filesize")) o.max_filesize = size_of(v), o.have_max_filesize = 1;
  else if (same(name, "ignore-file")) { if (o.nignore_file < 16) o.ignore_file[o.nignore_file++] = v; }
  else if (same(name, "no-ignore-vcs")) o.no_vcs = 1;
  else if (same(name, "no-ignore-dot")) o.no_dot = 1;
  else if (same(name, "no-ignore-exclude")) o.no_exclude = 1;
  else if (same(name, "type-add")) { if (o.ntype_add < 32) o.type_add[o.ntype_add++] = v; }
  else if (same(name, "type-clear")) { if (o.ntype_clear < 32) o.type_clear[o.ntype_clear++] = v; }
  else if (same(name, "type-list")) o.type_list = 1;
  else if (same(name, "follow")) o.follow = 1;
  else if (same(name, "no-follow")) o.follow = 0;
  else if (same(name, "binary")) o.binary = 1;
  else if (same(name, "no-binary")) o.binary = 0;
  else if (same(name, "pcre2")) usage("PCRE2 is not available in this build of ripgrep", 0);
  else if (same(name, "type")) { if (o.ntype < 32) o.type[o.ntype++] = v; }
  else if (same(name, "type-not")) { if (o.nuntype < 32) o.untype[o.nuntype++] = v; }
  else if (same(name, "color") || same(name, "colour")) o.colour = when(v);
  else if (same(name, "max-columns")) o.max_columns = number_of(v, "--max-columns");
  else if (same(name, "max-depth")) o.max_depth = (u32)number_of(v, "--max-depth");
  else if (same(name, "sort") || same(name, "sortr")) {
    if (!same(v, "path") && !same(v, "none")) usage("sorted only by path here: ", v);
    o.sort_reverse = same(name, "sortr") && same(v, "path");
  }
  /* What changes nothing here: one thread, the files mapped, none compressed searched as compressed, CRLF's \r kept. */
  else if (same(name, "sort-files") || same(name, "no-config") || same(name, "threads") || same(name, "encoding") ||
           same(name, "no-require-git") || same(name, "no-ignore-parent") || same(name, "no-ignore-global") ||
           same(name, "line-buffered") || same(name, "block-buffered") || same(name, "no-line-buffered") ||
           same(name, "no-block-buffered") || same(name, "engine") || same(name, "one-file-system") ||
           same(name, "no-one-file-system") || same(name, "search-zip") || same(name, "no-search-zip") || same(name, "crlf") ||
           same(name, "no-crlf") || same(name, "mmap") || same(name, "no-mmap") || same(name, "dfa-size-limit") ||
           same(name, "regex-size-limit") || same(name, "no-pcre2") || same(name, "auto-hybrid-regex") ||
           same(name, "no-auto-hybrid-regex") || same(name, "no-pcre2-unicode")) {}
  else if (same(name, "help")) { put("usage: rg [OPTIONS] PATTERN [PATH ...]\n", 39); flush(); leave(0); }
  else if (same(name, "version")) { put("ripgrep 15.2.0 (you)\n", 21); flush(); leave(0); }
  else usage("unrecognized flag --", name);
}
static void shortopts(const char *s, int argc, char **argv, int *a) {
  for (; *s; s++) {
    char c = *s;
    const char *v = 0;
    if (c == 'e' || c == 'm' || c == 'A' || c == 'B' || c == 'C' || c == 'g' || c == 't' || c == 'T' || c == 'M' ||
        c == 'd' || c == 'j' || c == 'E' || c == 'r' || c == 'f') {
      if (s[1]) v = s + 1;
      else if (*a + 1 < argc) v = argv[++*a];
      else usage("a value is wanted after -", (char[]){c, 0});
    }
    switch (c) {
      case 'e': if (o.npat < 64) o.pat[o.npat++] = v; return;
      case 'm': o.max_count = number_of(v, "-m"), o.have_max_count = 1; return;
      case 'A': o.after = (u32)number_of(v, "-A"), o.passthru = 0; return;
      case 'B': o.before = (u32)number_of(v, "-B"), o.passthru = 0; return;
      case 'C': o.after = o.before = (u32)number_of(v, "-C"), o.passthru = 0; return;
      case 'g': add_glob(v, 0); return;
      case 'r': o.replace = v; return;
      case 'f': if (o.npatfile < 16) o.patfile[o.npatfile++] = v; return;
      case 't': if (o.ntype < 32) o.type[o.ntype++] = v; return;
      case 'T': if (o.nuntype < 32) o.untype[o.nuntype++] = v; return;
      case 'M': o.max_columns = number_of(v, "-M"); return;
      case 'd': o.max_depth = (u32)number_of(v, "-d"); return;
      case 'j': case 'E': return;
      case 'F': o.fixed = 1; break;
      case 'i': o.kase = 1; break;
      case 'S': o.kase = 2; break;
      case 's': o.kase = 0; break;
      case 'w': o.word = 1, o.whole = 0; break;
      case 'x': o.whole = 1, o.word = 0; break;
      case 'v': o.invert = 1; break;
      case 'n': o.number = 1; break;
      case 'N': o.number = 0; break;
      case 'H': o.filename = 1; break;
      case 'I': o.filename = 0; break;
      case 'l': o.with = 1, o.without = 0; break;
      case 'c': o.count = 1, o.count_matches = 0; break;
      case 'o': o.only = 1; break;
      case 'q': o.quiet = 1; break;
      case 'a': o.text = 1; break;
      case '0': o.nul = 1; break;
      case 'p': o.colour = 1, o.heading = 1, o.number = 1; break;
      case '.': o.hidden = 1; break;
      case 'u': if (o.hidden) o.text = 1; else if (o.no_ignore) o.hidden = 1; else o.no_ignore = 1; break; /* -uuu */
      case 'L': o.follow = 1; break;
      case 'b': o.byte_offset = 1; break;
      case 'z': break;
      case 'P': usage("PCRE2 is not available in this build of ripgrep", 0);
      case 'h': longopt("help", 0, argc, argv, a); break;
      case 'V': longopt("version", 0, argc, argv, a); break;
      default: usage("unrecognized flag -", (char[]){c, 0});
    }
  }
}
static void options(int argc, char **argv, int config) {
  int ended = 0;
  for (int a = config ? 0 : 1; a < argc; a++) {
    const char *s = argv[a];
    if (!ended && s[0] == '-' && s[1]) {
      if (s[1] == '-' && !s[2]) { ended = 1; continue; }
      if (s[1] == '-') {
        u8 name[64];
        u32 k = 0;
        const char *v = 0;
        for (s += 2; *s && *s != '=' && k < sizeof name - 1; s++) name[k++] = (u8)*s;
        name[k] = 0;
        if (*s == '=') v = s + 1;
        longopt((const char *)name, v, argc, argv, &a);
      } else shortopts(s + 1, argc, argv, &a);
      continue;
    }
    if (config) continue; /* (a config file's lines are options only) */
    if (o.npath < 256) o.path[o.npath++] = s;
  }
}

/* RIPGREP_CONFIG_PATH's file: its arguments, one a line (blank lines and those starting with # aside). */
static void config(char **envp, int argc, char **argv) {
  for (int a = 1; a < argc; a++) if (same(argv[a], "--no-config")) return;
  const char *path = 0;
  for (char **e = envp; *e; e++) {
    const char *k = "RIPGREP_CONFIG_PATH=", *v = *e;
    while (*k && *k == *v) k++, v++;
    if (!*k) path = v;
  }
  if (!path || !*path) return;
  i64 fd = sys4(SYS_openat, AT_FDCWD, (i64)path, O_CLOEXEC, 0);
  if (fd < 0) { warn(path, fd); errors = 0; return; }
  u8 *b = grab(1 << 16);
  i64 n = sys3(SYS_read, fd, (i64)b, (1 << 16) - 1);
  sys1(SYS_close, fd);
  if (n <= 0) return;
  b[n] = 0;
  char *args[128];
  int k = 0;
  for (u8 *p = b, *end = b + n; p < end && k < 128;) {
    u8 *e = p;
    while (e < end && *e != '\n') e++;
    u8 *t = e;
    if (t > p && t[-1] == '\r') t--;
    *t = 0;
    if (t > p && *p != '#') args[k++] = (char *)p;
    p = e + 1;
  }
  options(k, args, 1);
}

/* ---- The pattern: those given, each as it is (or each character as itself: -F), as one; a word (-w) or the line
 * (-x) whole; case aside or not, smart case looking for a capital among the pattern's own characters. */
static int meta(char c) {
  for (const char *m = "\\.+*?()|[]{}^$#&-~"; *m; m++) if (*m == c) return 1;
  return 0;
}
/* -f's file of patterns (`-`: standard input), a line each (its \r\n or \n not part of it), after those given. */
static const char **pats;
static u32 npats;
static void add_pattern(const char *p) {
  if (!(npats & 63)) {
    const char **more = (const char **)grab(sizeof *more * (npats + 64));
    if (npats) memcpy(more, pats, sizeof *more * npats);
    pats = more;
  }
  pats[npats++] = p;
}
static void read_patterns(const char *file) {
  i64 fd = same(file, "-") ? 0 : sys4(SYS_openat, AT_FDCWD, (i64)file, O_CLOEXEC, 0);
  if (fd < 0) { warn(file, fd); flush(); leave(2); }
  u64 cap = 1 << 16, n = 0;
  u8 *b = grab(cap);
  for (i64 k; (k = sys3(SYS_read, fd, (i64)(b + n), (i64)(cap - n - 1))) > 0;) {
    n += (u64)k;
    if (n + 1 == cap) { u8 *m = grab(cap * 2); memcpy(m, b, n); b = m, cap *= 2; }
  }
  if (fd) sys1(SYS_close, fd);
  for (u64 at = 0; at < n;) {
    u64 e = at;
    while (e < n && b[e] != '\n') e++;
    u64 end = e > at && b[e - 1] == '\r' ? e - 1 : e;
    b[end] = 0;
    add_pattern((const char *)b + at);
    at = e + 1;
  }
}
static struct re *pattern(void) {
  for (u32 i = 0; i < o.npat; i++) add_pattern(o.pat[i]);
  for (u32 i = 0; i < o.npatfile; i++) read_patterns(o.patfile[i]);
  /* None at all (an empty file of them): nothing matches, as no line can hold a word's edge where none is. */
  if (!npats) add_pattern("\\b\\B");
  u64 cap = 64;
  for (u32 i = 0; i < npats; i++) cap += 2 * slen(pats[i]) + 8;
  u8 *p = grab(cap), *q = p;
  /* One pattern alone is given as it is (not in a group of its own): what every match holds is then seen in it (re/literal.h
   * required: a group's flags may differ inside, so a pattern that begins with one is asked no literal), and found by
   * that, a third faster. */
  int bare = npats == 1 && !o.whole && !o.word;
  const char *pre = o.whole ? "^(?:" : o.word ? "\\b(?:" : bare ? "" : "(?:";
  for (const char *s = pre; *s; s++) *q++ = (u8)*s;
  int capital = 0;
  for (u32 i = 0; i < npats; i++) {
    if (i) *q++ = '|';
    if (npats > 1) *q++ = '(', *q++ = '?', *q++ = ':';
    for (const char *s = pats[i]; *s; s++) {
      if (o.fixed && meta(*s)) *q++ = '\\';
      if (!o.fixed && *s == '\\' && s[1]) { *q++ = (u8)*s++; *q++ = (u8)*s; continue; } /* (\W \S: not capitals) */
      if (*s >= 'A' && *s <= 'Z') capital = 1;
      *q++ = (u8)*s;
    }
    if (npats > 1) *q++ = ')';
  }
  const char *post = o.whole ? ")$" : o.word ? ")\\b" : bare ? "" : ")";
  for (const char *s = post; *s; s++) *q++ = (u8)*s;
  int flags = RE_LINES | (o.kase == 1 || (o.kase == 2 && !capital) ? RE_ICASE : 0) | (o.replace ? RE_CAPTURE : 0);
  struct re *r = re_compile(p, (u32)(q - p), flags);
  if (!r) usage("regex parse error: ", re_error);
  return r;
}
