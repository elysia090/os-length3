/*
 * you's rg: a tree searched as ripgrep searches it, by you's regular expressions (re/): what it
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
#include "re/automaton.h"
#include "re/class.h"
#include "re/parse.h"
#include "re/literal.h"
#include "re/reverse.h"
#include "re/word.h"
#include "re/find.h"
#include "re/pike.h"
#include "re/dfa.h"
#include "re/grep.h"
#include "rg/types.h"

enum { SYS_munmap = 11, SYS_ioctl = 16, SYS_openat = 257 };
#define O_DIRECTORY 0200000
#define O_CLOEXEC 02000000
#define DT_DIR 4
#define DT_REG 8
#define DT_LNK 10
#define DT_UNKNOWN 0
#include "rg/options.h"
#include "rg/ignore.h"
#include "rg/print.h"

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
