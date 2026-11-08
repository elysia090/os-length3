/*
 * you's rg: a tree searched as ripgrep searches it, by you's regular expressions (regex.c, dfa.c, grep.c): what it
 * prints, and in what form, is ripgrep's, so that a person or a program used to rg finds it as it was.
 *
 *   rg [OPTION...] PATTERN [PATH...]
 *   rg [OPTION...] -e PATTERN... [PATH...]
 *   rg [OPTION...] --files [PATH...]
 *
 * What it searches: each PATH named (a file, searched whatever it is), and below each directory named (`.` when none
 * is, or standard input when that is a pipe or a file) every file but those its ignore files leave out (.gitignore in
 * a repository, .ignore, .rgignore, the repository's .git/info/exclude; the deeper over the shallower, .rgignore over
 * .ignore over .gitignore, a later line over an earlier one), hidden ones (a name that starts with a dot), binary ones
 * (a NUL in it), and those -g and -t leave out. A directory's entries in the order of their names, so what it prints
 * is the same from one run to the next (ripgrep's --sort path).
 *
 * How it prints a line that holds a match: its path (when more than one file can be searched), its number (to a
 * terminal), the line; to a terminal, each file's path once as a heading over its lines, and the path, the numbers and
 * each match in ripgrep's colours. Options as ripgrep's: -e -f -F -i -S -s -w -x -v -n -N -H -I -l -c -o -q -m -A -B -C
 * -r -b -g -t -T -u -. -0 -a -p -L --files --files-without-match --count-matches --column --vimgrep --heading
 * --no-heading --color --hidden --no-ignore --no-ignore-vcs --no-ignore-dot --no-ignore-exclude --ignore-file --iglob
 * --glob-case-insensitive --type-add --type-clear --type-list --trim --passthru --include-zero --binary
 * --context-separator --no-context-separator --field-match-separator --field-context-separator --max-filesize
 * --max-columns --max-columns-preview --max-depth --sort path --sortr path --no-messages (and those that change nothing
 * with one thread: -j, --line-buffered, --mmap, -z on files not compressed), and RIPGREP_CONFIG_PATH's file of
 * arguments, one a line, before the command's own (--no-config: not it). Not yet: -U, --json, --colors, \p{...}.
 *
 * What it works in: the files mapped (their text is never copied: what it prints is written from the map), its
 * patterns' DFAs in the arena, and what the walk holds (names, ignore rules) in a stack of its own, given back as each
 * directory is done, so a tree of any size is walked in what its deepest path needs.
 */
#define UNIT "rg"
#define ARENA (1 << 25) /* the patterns' automata and DFAs, and standard input's text */
#include "../../lib/io.h"
#include "regex.c"
#include "dfa.c"
#include "grep.c"
#include "types.h"

enum { SYS_munmap = 11, SYS_ioctl = 16, SYS_openat = 257 };
#define O_DIRECTORY 0200000
#define O_CLOEXEC 02000000
#define DT_DIR 4
#define DT_REG 8
#define DT_LNK 10
#define DT_UNKNOWN 0

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
  /* One pattern alone is given as it is (not in a group of its own): what every match holds is then seen in it (regex.c
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

/* ---- Printing: ripgrep's colours, a number, the path. */
#define PATH_IN "\x1b[0m\x1b[35m"
#define LINE_IN "\x1b[0m\x1b[32m"
#define MATCH_IN "\x1b[0m\x1b[1m\x1b[31m"
#define OUT "\x1b[0m"
#define S(s) put(s, sizeof s - 1)
static void putn(u64 v) {
  u8 *e = piece(), *p = e;
  do *--p = (u8)('0' + v % 10); while (v /= 10);
  put(p, (u64)(e - p));
}
static void put_path(void) {
  if (o.colour) S(PATH_IN);
  put(path + shown, pathn - shown);
  if (o.colour) S(OUT);
}

/* ---- One file's text searched, and what it holds printed. */
static struct grep g;
static int spans; /* each match on a line is wanted (its colour, -o, --column, --count-matches) */
static int printed_any, heading_said, last_ctx_file;
static u64 last_printed; /* the number of the last line printed in this file (0: none yet) */

/* The newlines in t[k..at), 64 bytes a step (AVX2): each 32's a mask, counted. */
__attribute__((target("avx2,popcnt"))) static u64 newlines_avx2(const u8 *t, u64 *k, u64 at) {
  const v32 nl = (v32){0} + '\n';
  u64 c = 0, i = *k;
  for (; i + 64 <= at; i += 64)
    c += (u64)__builtin_popcountll((u64)mask32(ld256(t + i) == nl) | (u64)mask32(ld256(t + i + 32) == nl) << 32);
  *k = i;
  return c;
}
/* The number of the line t[at..] starts, counting on from (*lnum, *lat). */
static u64 line_no(const u8 *t, u64 at, u64 *lnum, u64 *lat) {
  u64 k = *lat, c = 0;
  if (avx2) c = newlines_avx2(t, &k, at);
  for (; k + 8 <= at; k += 8) {
    u64 x = ld64(t + k) ^ 0x0a0a0a0a0a0a0a0aull, z = (x - 0x0101010101010101ull) & ~x & 0x8080808080808080ull;
    c += ((z >> 7) * 0x0101010101010101ull) >> 56;
  }
  for (; k < at; k++) c += t[k] == '\n';
  *lnum += c, *lat = at;
  return *lnum;
}

static void head(void) {
  if (heading_said) return;
  heading_said = 1;
  if (!o.heading || !o.filename) return;
  if (printed_any) S("\n");
  put_path();
  S("\n");
}
/* What a printed line begins with: its path, number, column and byte offset (-b: `off`), each and its separator (`:`
 * for a line that holds a match, `-` for one around it: --field-match-separator, --field-context-separator). */
static void prefix(u64 lnum, u64 col, u64 off, u8 sep) {
  const char *s = sep == ':' ? (o.field_match ? o.field_match : ":") : (o.field_ctx ? o.field_ctx : "-");
  u64 sn = slen(s);
  if (o.filename && !o.heading) { put_path(); o.nul ? put("\0", 1) : put(s, sn); }
  if (o.number) {
    if (o.colour) S(LINE_IN);
    putn(lnum);
    if (o.colour) S(OUT);
    put(s, sn);
  }
  if (col) { putn(col); put(s, sn); }
  if (o.byte_offset) { putn(off); put(s, sn); }
}
static void separate(u64 lnum) {
  if (!o.after && !o.before) return;
  if ((last_ctx_file || (last_printed && lnum != last_printed + 1)) && !o.no_ctx_sep) {
    const char *c = o.ctx_sep ? o.ctx_sep : "--";
    put(c, slen(c));
    S("\n");
  }
  last_ctx_file = 0;
}

/* -r's replacement for the match t[ms..me): $N or ${N} group N's text (0 the match), $name or ${name} a named group's,
 * $$ a $; a group not there, or that took no part, nothing; as Rust's regex crate expands it. A $name takes all the
 * letters, digits and _ after it ($1a is the group named 1a). */
static struct re *rx;
static u64 text_n, cap[256], cap_at = ~0ull; /* the groups of the match at cap_at, found once for all its $s */
static void group(const u8 *t, u64 ms, u64 me, const char *nm, u32 len) {
  u32 k = 0, digits = 1;
  for (u32 i = 0; i < len; i++) digits &= nm[i] >= '0' && nm[i] <= '9';
  if (digits) for (u32 i = 0; i < len && k < 1000; i++) k = k * 10 + (u32)(nm[i] - '0');
  else {
    for (k = 1; k <= rx->groups && k < 128; k++) if (rx->gnamen[k] == len && !memcmp(rx->gname[k], nm, len)) break;
    if (k > rx->groups || k >= 128) return;
  }
  if (!k) { put(t + ms, me - ms); return; }
  if (k > rx->groups || k >= 128) return;
  if (cap_at != ms) {
    cap_at = ms;
    if (!re_captures(rx, t, text_n, ms, cap)) for (u32 i = 0; i < 256; i++) cap[i] = ~0ull;
  }
  if (cap[2 * k] != ~0ull && cap[2 * k + 1] != ~0ull) put(t + cap[2 * k], cap[2 * k + 1] - cap[2 * k]);
}
static void replaced(const u8 *t, u64 ms, u64 me) {
  const char *r = o.replace;
  for (const char *p = r;;) {
    const char *d = p;
    while (*d && *d != '$') d++;
    put(p, (u64)(d - p));
    if (!*d) return;
    const char *nm = d + 1, *e = nm;
    int braced = *nm == '{';
    if (*nm == '$') { put("$", 1); p = nm + 1; continue; }
    if (braced) { for (e = ++nm; *e && *e != '}'; e++) {} }
    else for (; (*e >= '0' && *e <= '9') || (*e >= 'a' && *e <= 'z') || (*e >= 'A' && *e <= 'Z') || *e == '_'; e++) {}
    if (e == nm || (braced && !*e)) { put("$", 1); p = d + 1; continue; } /* (a $ before nothing that names: itself) */
    group(t, ms, me, nm, (u32)(e - nm));
    p = braced ? e + 1 : e;
  }
}

/* A file named (ripgrep maps it, BinaryDetection::convert) whose first 64 KiB hold no NUL: a line about to be printed
 * that holds one is said to be binary in its place (where it is), and nothing more of the file is printed. */
static int convert, bin_hit;
static u64 first_nul(const u8 *t, u64 n);
/* The line t[ls..le) printed as one that holds a match (`sep` ':') or one around it ('-'). */
static void print_line(const u8 *t, u64 ls, u64 le, u64 lnum, u8 sep) {
  head();
  separate(lnum);
  if (convert) {
    u64 z = first_nul(t + ls, le - ls);
    if (z < le - ls) {
      if (o.filename && !o.heading) { put_path(); S(": "); }
      S("binary file matches (found \"\\0\" byte around offset ");
      putn(ls + z);
      S(")\n");
      bin_hit = 1;
      return;
    }
  }
  printed_any = 1, last_printed = lnum;
  u64 x = ls, last = ~0ull, ms, me;
  if (sep == ':' && (o.only || o.vimgrep || o.column)) {
    int any = 0;
    while (grep_span(&g, ls, le, &x, &last, &ms, &me)) {
      if (o.only && ms == me) continue;
      any = 1;
      prefix(lnum, o.column || o.vimgrep ? ms - ls + 1 : 0, o.only ? ms : ls, sep);
      if (o.only) {
        if (o.colour) S(MATCH_IN);
        o.replace ? replaced(t, ms, me) : put(t + ms, me - ms);
        if (o.colour) S(OUT);
        S("\n");
        continue;
      }
      put(t + ls, le - ls);
      S("\n");
      if (!o.vimgrep) break;
    }
    if (any || o.only) return;
  }
  prefix(lnum, 0, ls, sep);
  /* --trim: what it begins with that is blank is not printed. */
  u64 from = ls;
  if (o.trim) while (from < le && (t[from] == ' ' || t[from] == '\t' || (t[from] >= 11 && t[from] <= 13))) from++;
  if (o.max_columns && le - from > o.max_columns) {
    if (o.preview) { put(t + from, o.max_columns); S(" [... omitted end of long line]\n"); return; }
    sep == ':' ? S("[Omitted long matching line]\n") : S("[Omitted long context line]\n");
    return;
  }
  if ((o.colour || o.replace) && sep == ':' && !o.invert) {
    /* Each match in its colour, or replaced (-r: an empty match too, as ripgrep replaces it). */
    u64 at = from;
    while (grep_span(&g, ls, le, &x, &last, &ms, &me)) {
      if ((ms == me && !o.replace) || ms < at) continue;
      put(t + at, ms - at);
      if (o.colour) S(MATCH_IN);
      o.replace ? replaced(t, ms, me) : put(t + ms, me - ms);
      if (o.colour) S(OUT);
      at = me;
    }
    put(t + at, le - at);
  } else put(t + from, le - from);
  S("\n");
}

/* The next line that holds a match (its start), or n: grep.c's, each line it gives checked where it may hold none
 * (spans: the first match found, which grep_span is asked for again as the line is printed). */
static u64 next_match(const u8 *t, u64 n) {
  for (;;) {
    u64 ls = grep_line(&g);
    if (ls >= n || !spans) return ls;
    u64 le = line_end(t, n, ls), x = ls, last = ~0ull, ms, me;
    if (grep_span(&g, ls, le, &x, &last, &ms, &me)) return ls;
  }
}
/* The next line selected at or after *at: the next that holds a match, or with -v the next that holds none (`nm` the
 * next that does, found once and passed). */
static u64 nm;
static u64 next_selected(const u8 *t, u64 n, u64 at) {
  if (!o.invert) return next_match(t, n);
  for (; at < n; at = line_end(t, n, at) + 1) {
    while (nm < at) nm = next_match(t, n);
    if (at != nm) return at;
  }
  return n;
}
/* Where the first NUL is in t[0..n), or n: 64 bytes a step (AVX2), else eight. As ripgrep has it where it walks to a
 * file, the whole of it is looked at (a NUL anywhere: binary). */
__attribute__((target("avx2"))) static u64 nul_avx2(const u8 *t, u64 n) {
  const v32 z = (v32){0};
  u64 k = 0;
  for (; k + 64 <= n; k += 64) if (mask32((ld256(t + k) == z) | (ld256(t + k + 32) == z))) break;
  return k;
}
static u64 first_nul(const u8 *t, u64 n) {
  u64 k = avx2 ? nul_avx2(t, n) : 0;
  for (; k + 8 <= n; k += 8) {
    u64 x = ld64(t + k);
    if ((x - 0x0101010101010101ull) & ~x & 0x8080808080808080ull) break;
  }
  for (; k < n; k++) if (!t[k]) return k;
  return n;
}
/* After a selected line: up to o.after lines from t[c..] that come before `to`, numbered on from `num`. */
static u64 after_lines(const u8 *t, u64 n, u64 c, u64 to, u64 *num, u32 *left) {
  for (; *left && c < to && c < n && !bin_hit; --*left) {
    u64 ce = line_end(t, n, c);
    print_line(t, c, ce, (*num)++, '-');
    c = ce + 1;
  }
  return c;
}

/*
 * The text a read at a time, as ripgrep reads a file: 64 KiB (twice as much where a line is longer than all it holds),
 * each read after the last line it had whole, its whole lines searched as it is made (grep-searcher's LineBuffer). In
 * a file the walk came to (`quit`), a read that holds a NUL is where it stops: nothing that read holds is searched
 * (BinaryDetection::quit). Searched a read at a time here too: what was just looked over for a NUL is searched while it
 * is still in the cache, not read again from memory after a pass over the whole file. The next read's end (after its
 * last newline, or the file's end), or, at a read that holds a NUL, `nul` set and the end of what was searched.
 */
struct reads { u64 cap, got, whole, nul; int quit; };
static u64 next_read(const u8 *t, u64 n, struct reads *r) {
  for (;;) {
    if (r->got - r->whole >= r->cap) r->cap *= 2;
    u64 len = r->cap - (r->got - r->whole);
    if (len > n - r->got) len = n - r->got;
    if (!len) return r->whole = n;
    u64 from = r->got;
    r->got += len;
    if (r->quit) {
      u64 z = first_nul(t + from, len);
      if (z < len) { r->nul = from + z; return r->whole; }
    }
    u64 e = r->got;
    while (e > from && t[e - 1] != '\n') e--;
    if (e > from) return r->whole = e;
  }
}

/* t[0..n) searched; `named`: a file named, not one the walk came to. Whether a line was selected. */
static int search_text(const u8 *t, u64 n, int named) {
  text_n = n, cap_at = ~0ull;
  heading_said = 0, last_printed = 0;
  /* A NUL, as ripgrep looks for one: in a file the walk came to, read by read (next_read: it stops there); in one named
   * (which it maps), in its first 64 KiB; with --binary, anywhere. Those two are said to hold a match, or not. */
  int quit = !named && !o.text && !o.binary;
  convert = !quit && !o.text, bin_hit = 0;
  u64 look = named && n > 65536 ? 65536 : n, nul = o.text || quit ? n : first_nul(t, look);
  if (nul == look) nul = n;
  grep_text(&g, t, n);
  g.spans = spans;
  if (nul < n) {
    if (next_match(t, n) >= n) return 0;
    /* (With lines before a match asked for, ripgrep says nothing of such a file and finds nothing in it; counted, or
     * only named, it is as any.) */
    if (o.before && !o.count && !o.count_matches && !o.with && !o.without && !o.quiet) return 0;
    if (o.quiet) leave(0);
    if (o.with) { put_path(); o.nul ? put("\0", 1) : S("\n"); return 1; }
    if (o.without) return 1;
    if (o.count || o.count_matches) goto counted; /* (counted as any file is) */
    if (o.filename) { put_path(); S(": "); }
    S("binary file matches (found \"\\0\" byte around offset ");
    putn(nul);
    S(")\n");
    return 1;
  }
counted:;
  struct reads rd = {65536, 0, 0, n, quit && nul == n};
  u64 upto = next_read(t, n, &rd);
  grep_text(&g, t, upto);
  g.spans = spans;
  nm = 0;
  if (o.invert) nm = next_match(t, upto);
  u64 lnum = 1, lat = 0, count = 0, matches = 0, ctx = 0, ctx_num = 0;
  int numbered = o.number || o.after || o.before || o.vimgrep;
  u32 left = 0;
  for (u64 at = 0;;) {
    if (at >= upto) {
      /* This read's lines done: those after the last selected that are its, its lines numbered to its end (while it is
       * still in the cache), and the next read, unless this was the last or the next holds a NUL. */
      if (left) ctx = after_lines(t, upto, ctx, upto, &ctx_num, &left);
      if (upto == n || rd.nul < n) break;
      if (numbered) line_no(t, upto, &lnum, &lat);
      u64 was = upto;
      upto = next_read(t, n, &rd);
      if (upto == was) break;
      grep_upto(&g, upto);
      if (o.invert && nm >= was) nm = next_match(t, upto); /* (none in the read before: whether one is in this) */
      continue;
    }
    u64 ls = next_selected(t, upto, at);
    if (ls >= upto) { at = upto; continue; }
    /* Its number, where anything says it (-n, or the lines around it, numbered on from it): counting every newline
     * before it is a pass over the text, which -c, -l or a line printed bare does not need. */
    u64 le = line_end(t, upto, ls), num = numbered ? line_no(t, ls, &lnum, &lat) : 0;
    if (o.quiet) leave(0);
    count++;
    if (o.count_matches) for (u64 x = ls, last = ~0ull, ms, me; grep_span(&g, ls, le, &x, &last, &ms, &me);) matches++;
    if (o.with || o.without) break;
    if (!o.count && !o.count_matches) {
      /* What is around it: after the last one selected (until this), and before this one (from the last printed on). */
      if (left) ctx = after_lines(t, upto, ctx, ls, &ctx_num, &left);
      if (o.before) {
        u64 c = ls, k = 0;
        while (k < o.before && c > 0 && num - k - 1 > last_printed) c = line_start(t, 0, c - 1), k++;
        for (u64 i = 0; c < ls && !bin_hit; i++) { u64 ce = line_end(t, upto, c); print_line(t, c, ce, num - k + i, '-'); c = ce + 1; }
      }
      if (!bin_hit) print_line(t, ls, le, num, ':');
      left = o.after, ctx = le + 1, ctx_num = num + 1;
      if (bin_hit) return 1; /* (said binary where it was: nothing more of it printed) */
    }
    at = le < upto ? le + 1 : upto;
    if (o.have_max_count && count >= o.max_count) break;
  }
  if (left) after_lines(t, upto, ctx, upto, &ctx_num, &left);
  /* Stopped at a read that held a NUL: with nothing found before it, the file is passed over and nothing said of it;
   * with something, what was found stands (its count not said), and where it stopped is said, as ripgrep says it. */
  int stopped = rd.nul < n;
  if (bin_hit) return 1;
  if (stopped && (!count || o.count || o.count_matches)) return 0; /* (a count not said: nothing found, as it ends) */
  if (count && (o.after || o.before) && !o.heading) last_ctx_file = 1;
  if (o.with && count) { put_path(); o.nul ? put("\0", 1) : S("\n"); }
  if (o.without && !count) { put_path(); o.nul ? put("\0", 1) : S("\n"); }
  if ((o.count || o.count_matches) && (count || o.include_zero) && !stopped) {
    if (o.filename) { put_path(); o.nul ? put("\0", 1) : S(":"); }
    putn(o.count_matches ? matches : count);
    S("\n");
  }
  if (stopped && !o.count && !o.count_matches && !o.with) {
    if (o.filename) { put_path(); S(": "); }
    S("WARNING: stopped searching binary file after match (found \"\\0\" byte around offset ");
    putn(rd.nul);
    S(")\n");
  }
  return count > 0;
}

/* The file at `path` (opened at `dir`, by `name`) searched. */
static u64 searched; /* how many files were: none, where no path was named, is said */
static void search_file(int dir, const char *name, int named) {
  struct kstat st;
  if (o.files) {
    /* (A file larger than --max-filesize is left out where the walk came to it.) */
    if (!named && o.have_max_filesize && !sys4(SYS_newfstatat, dir, (i64)name, (i64)&st, 0) && (u64)st.size > o.max_filesize) return;
    searched++;
    put_path(); o.nul ? put("\0", 1) : S("\n"); flush(); found = 1; return;
  }
  i64 fd = sys4(SYS_openat, dir, (i64)name, O_CLOEXEC, 0);
  path[pathn] = 0;
  if (fd < 0) { warn((const char *)path + shown, fd); return; }
  int fine = sys2(SYS_fstat, fd, (i64)&st) == 0;
  if (fine && !named && o.have_max_filesize && (u64)st.size > o.max_filesize) { sys1(SYS_close, fd); return; }
  searched++;
  if (fine && IS_REG(st.mode) && st.size > 0) {
    i64 m = sys6(SYS_mmap, 0, st.size, 1, 2, fd, 0);
    if (m < 0 && m > -4096) warn((const char *)path + shown, m);
    else {
      found |= search_text((const u8 *)m, (u64)st.size, named);
      flush();
      sys2(SYS_munmap, m, st.size);
    }
  }
  sys1(SYS_close, fd);
}

/* -L: whether the directory a link at `path` leads to (`to`) is one the walk is in already, said as ripgrep says it (the
 * paths as the walk has them: ./ before them where the root was not named). */
static int unnamed; /* the walk's root is the `.` not named */
static int looped(const struct level *l, const struct kstat *to) {
  for (const struct level *a = l; a; a = a->up) {
    if ((!a->dev && !a->ino) || a->dev != to->dev || a->ino != to->ino) continue;
    errors = 1;
    if (!o.messages) return 1;
    flush();
    u8 m[9000];
    u64 k = 0;
    const u8 *s[] = {(const u8 *)"rg: File system loop found: ", (const u8 *)(unnamed ? "./" : ""), path + shown,
                     (const u8 *)" points to an ancestor ", (const u8 *)(unnamed ? "./" : ""), path + shown};
    u32 len[] = {28, unnamed ? 2u : 0u, pathn - shown, 23, unnamed ? 2u : 0u, a->at > shown + 1 ? a->at - shown - 1 : 0};
    for (int i = 0; i < 6; i++) if (k + len[i] < sizeof m - 1) memcpy(m + k, s[i], len[i]), k += len[i];
    m[k++] = '\n';
    sys3(SYS_write, 2, (i64)m, (i64)k);
    return 1;
  }
  return 0;
}

/* Below the directory open as `fd` (its path in `path`), each entry in the order of its name. */
static void walk_dir(int fd, struct level *up, u32 depth, u32 root) {
  u64 mark = walked;
  struct level *l = (struct level *)hold(sizeof *l);
  u32 base = pathn + (pathn && path[pathn - 1] != '/'); /* where an entry's name goes, after a slash */
  l->up = up, l->nfile = 0, l->at = base, l->repo = up ? up->repo : 0;
  if (!depth) root = base;
  struct kstat st;
  l->dev = l->ino = 0;
  if (o.follow && !sys2(SYS_fstat, fd, (i64)&st)) l->dev = st.dev, l->ino = st.ino;
  if (!sys4(SYS_newfstatat, fd, (i64)".git", (i64)&st, 0x100 /* AT_SYMLINK_NOFOLLOW */)) l->repo = 1;
  if (!o.no_ignore) {
    if (!o.no_dot) l->file[l->nfile++] = read_rules(fd, ".rgignore"), l->file[l->nfile++] = read_rules(fd, ".ignore");
    if (l->repo && !o.no_vcs) l->file[l->nfile++] = read_rules(fd, ".gitignore");
    if (l->repo && !o.no_vcs && !o.no_exclude && !sys4(SYS_newfstatat, fd, (i64)".git", (i64)&st, 0x100) && IS_DIR(st.mode))
      l->file[l->nfile++] = read_rules(fd, ".git/info/exclude");
  }
  /* The entries, read whole, then sorted by name (a merge of runs: no recursion, no more room than one list again). */
  u32 cap = 256, n = 0;
  const u8 **names = (const u8 **)hold(sizeof *names * cap);
  u8 *types = hold(cap);
  for (;;) {
    u8 *b = hold(1 << 15);
    i64 k = sys3(SYS_getdents64, fd, (i64)b, 1 << 15);
    if (k <= 0) break;
    for (i64 at = 0; at < k;) {
      u16 len = ld16(b + at + 16);
      const u8 *nm = b + at + 19;
      if (!(nm[0] == '.' && (!nm[1] || (nm[1] == '.' && !nm[2])))) {
        if (n == cap) {
          const u8 **more = (const u8 **)hold(sizeof *names * cap * 2);
          u8 *mt = hold(cap * 2);
          memcpy(more, names, sizeof *names * n), memcpy(mt, types, n);
          names = more, types = mt, cap *= 2;
        }
        types[n] = b[at + 18], names[n++] = nm;
      }
      at += len;
    }
  }
  u32 *order = (u32 *)hold(4 * (u64)n), *tmp = (u32 *)hold(4 * (u64)n);
  for (u32 i = 0; i < n; i++) order[i] = i;
  for (u32 w = 1; w < n; w *= 2) {
    for (u32 lo = 0; lo < n; lo += 2 * w) {
      u32 mid = lo + w < n ? lo + w : n, hi = lo + 2 * w < n ? lo + 2 * w : n, a = lo, b = mid, c = lo;
      while (a < mid || b < hi) {
        int take_a = b >= hi;
        if (a < mid && b < hi) {
          const u8 *x = names[order[a]], *y = names[order[b]];
          while (*x && *x == *y) x++, y++;
          take_a = *x <= *y;
        }
        tmp[c++] = take_a ? order[a++] : order[b++];
      }
    }
    u32 *s = order; order = tmp, tmp = s;
  }
  for (u32 i = 0; i < n && depth < o.max_depth; i++) { /* (its entries a level deeper: none at --max-depth 0) */
    u32 at = order[o.sort_reverse ? n - 1 - i : i];
    const u8 *nm = names[at];
    u32 nn = (u32)slen((const char *)nm), was = pathn;
    if (pathn + nn + 2 >= sizeof path) continue;
    if (base > pathn) path[pathn++] = '/';
    memcpy(path + pathn, nm, nn), pathn += nn;
    u8 t = types[at];
    int link = t == DT_LNK;
    if (t == DT_UNKNOWN || t == DT_LNK) {
      if (!sys4(SYS_newfstatat, fd, (i64)nm, (i64)&st, link && !o.follow ? 0x100 : 0))
        t = IS_DIR(st.mode) ? DT_DIR : IS_REG(st.mode) ? DT_REG : t;
    }
    if (t == DT_DIR && link && looped(l, &st)) { pathn = was; continue; }
    if (t == DT_DIR) {
      if (taken(l, nm, nn, 1, root) > 0 && depth + 1 < o.max_depth) {
        i64 d = sys4(SYS_openat, fd, (i64)nm, O_DIRECTORY | O_CLOEXEC, 0);
        if (d >= 0) { walk_dir((int)d, l, depth + 1, root); sys1(SYS_close, d); }
        else { path[pathn] = 0; warn((const char *)path + shown, d); }
      }
    } else if (t == DT_REG && taken(l, nm, nn, 0, root) > 0) search_file(fd, (const char *)nm, 0);
    pathn = was;
  }
  walked = mark;
}

/* Whether a directory above `p` (`p/..`, `p/../..`, up to /) holds a .git: `p` is in a repository. */
static int in_repo(const char *p) {
  u8 q[4096];
  u32 m = (u32)slen(p);
  if (m > 3000) return 0;
  memcpy(q, p, m);
  struct kstat a, b;
  for (int k = 0; k < 256 && m + 10 < sizeof q; k++) {
    memcpy(q + m, "/..", 4), m += 3;
    memcpy(q + m, "/.git", 6);
    if (!sys4(SYS_newfstatat, AT_FDCWD, (i64)q, (i64)&a, 0x100)) return 1;
    q[m] = 0;
    if (sys4(SYS_newfstatat, AT_FDCWD, (i64)q, (i64)&a, 0)) return 0;
    memcpy(q + m, "/..", 4);
    if (sys4(SYS_newfstatat, AT_FDCWD, (i64)q, (i64)&b, 0) || (a.ino == b.ino && a.dev == b.dev)) return 0; /* (/) */
  }
  return 0;
}

static int main_(int argc, char **argv, char **envp) {
  config(envp, argc, argv);
  options(argc, argv, 0);
  for (u32 k = 0; k < o.ntype_add; k++) {
    const char *d = o.type_add[k];
    u32 dn = 0;
    while (d[dn] && d[dn] != ':') dn++;
    if (!dn || !d[dn] || !d[dn + 1]) usage("invalid definition (format is type:glob, e.g., html:*.html)", 0);
  }
  if (o.type_list) { list_types(); flush(); leave(0); }
  if (o.passthru) o.after = o.before = 1u << 30; /* (every line: those around a match, all of them) */
  for (u32 k = 0; k < o.nignore_file; k++) given[ngiven++] = read_rules(AT_FDCWD, o.ignore_file[k]);
  /* Without -e or -f, the first of what is not an option is the pattern; the rest are paths. */
  if (!o.npat && !o.npatfile && !o.files) {
    if (!o.npath) usage("no pattern given", 0);
    o.pat[o.npat++] = o.path[0];
    for (u32 i = 1; i < o.npath; i++) o.path[i - 1] = o.path[i];
    o.npath--;
  }
  u8 termios[64];
  tty = sys3(SYS_ioctl, 1, 0x5401 /* TCGETS */, (i64)termios) == 0;
  if (o.colour < 0) o.colour = tty;
  if (o.number < 0) o.number = tty || o.vimgrep;
  if (o.heading < 0) o.heading = tty && !o.vimgrep;
  if (o.vimgrep) o.heading = 0, o.column = 1, o.number = 1;
  if (o.column) o.number = 1; /* (--column says the line's number too) */
  if (o.with || o.without || o.count || o.count_matches) o.heading = 0;
  struct kstat st;
  int from_stdin = !o.npath && !o.files && !sys2(SYS_fstat, 0, (i64)&st) &&
                   (IS_REG(st.mode) || (st.mode & 0170000) == 0010000 || (st.mode & 0170000) == 0140000);
  if (o.filename < 0) {
    o.filename = o.npath > 1 || (!o.npath && !from_stdin);
    for (u32 i = 0; i < o.npath && !o.filename; i++)
      o.filename = !sys4(SYS_newfstatat, AT_FDCWD, (i64)o.path[i], (i64)&st, 0) && IS_DIR(st.mode);
  }
  if (!o.files) {
    struct re *r = rx = pattern();
    spans = o.only || o.vimgrep || o.column || o.colour || o.count_matches || o.max_columns || o.replace;
    re_classes(r);
    if (spans && !r->only_lit) re_classes(re_reverse(r));
    grep_init(&g, r);
  }
  if (from_stdin) {
    u8 *b = grab(1 << 24);
    u64 n = 0;
    for (i64 k; n < (1 << 24) && (k = sys3(SYS_read, 0, (i64)(b + n), (i64)((1 << 24) - n))) > 0;) n += (u64)k;
    memcpy(path, "<stdin>", 7), pathn = 7, shown = 0;
    searched++;
    found |= search_text(b, n, 1);
    flush();
  }
  int implicit = !o.npath && !from_stdin; /* no path named: the walk is of `.` */
  if (implicit) o.path[o.npath++] = 0;
  for (u32 i = 0; i < o.npath; i++) {
    const char *p = o.path[i] ? o.path[i] : ".";
    unnamed = !o.path[i];
    u32 n = (u32)slen(p);
    if (n >= sizeof path - 1) continue;
    memcpy(path, p, n), pathn = n, shown = 0;
    if (!o.path[i]) pathn = 0; /* `.` not named: its paths printed without it */
    i64 e = sys4(SYS_newfstatat, AT_FDCWD, (i64)p, (i64)&st, 0);
    if (e) { warn_as(p, e, 1); continue; }
    if (IS_DIR(st.mode)) {
      i64 d = sys4(SYS_openat, AT_FDCWD, (i64)p, O_DIRECTORY | O_CLOEXEC, 0);
      if (d < 0) { warn(p, d); continue; }
      /* (Above the root: whether it is in a repository, for its .gitignore.) */
      struct level up = {.nfile = 0, .at = 0, .up = 0, .repo = in_repo(p)};
      walk_dir((int)d, &up, 0, pathn);
      sys1(SYS_close, d);
    } else search_file(AT_FDCWD, p, 1);
  }
  flush();
  /* Where the walk was of `.` not named and it searched nothing: said, as ripgrep says it (a filter left all out). */
  if (implicit && !searched) {
    static const char said[] = "rg: No files were searched, which means ripgrep probably applied a filter you didn't expect.\n"
                               "Running with --debug will show why files are being skipped.\n";
    sys3(SYS_write, 2, (i64)said, sizeof said - 1);
    errors = 1;
  }
  return errors && !(o.quiet && found) ? 2 : !found;
}
