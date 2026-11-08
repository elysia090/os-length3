/*
 * otter: what a Prompt has, and what each thing is (a unit of C: lib's three headers and this; its checks in
 * test/). `help` in the Prompt's shell is otter (/etc/length3/shrc), and so are whatis and apropos (their links).
 *
 *   otter                  every command a Prompt is asked for, by kind, each marked by what was seen of it here
 *   otter NAME...          what each is (its tldr page's words), whether it runs here, and what instead when not
 *   otter -f NAME...       whatis: one line each, `NAME (1) - what it is`
 *   otter -k WORD...       apropos: the root's programs whose name or words hold a WORD, case aside, one line each
 *
 * The marks are the table's (/etc/length3/commands, which scripts/commands.ts writes from what each command did
 * under the browser's kernel and natively, never from what is hoped): ✓ runs here, ▢ draws on a screen, ✗ in the root
 * but not yet running here (and why), — not in the root (and what to reach for instead). One that draws on a screen
 * runs where the Prompt is a terminal ($TERM other than dumb: the app's on the web, a terminal over SSH), and is
 * marked ✓ there; ▢ only where the Prompt shows output alone (TERM=dumb). What a thing is comes from the root's tldr
 * pages, in the person's language first ($LENGTH3_LANG=ja: pages.ja, then pages.en), common's then linux's.
 *
 * whatis and apropos say as man-db's do: a name with nothing to say of it is `NAME: nothing appropriate.`, and the run
 * ends 16 when any was. $OTTER_TABLE and $OTTER_PAGES (the folder pages.en is in) stand in for the root's, for checks.
 *
 * No C library, no allocation: the table is read whole into the arena (a few kilobytes), a page's first 4 KiB, and
 * apropos reads the folders of programs once. Its own few pages, which a browser's Prompt translates in a moment.
 */
#define UNIT "otter"
#include "../../lib/io.h"

/* ---- What it was given (no pointer is set before it runs: a pointer in its data would be something to relocate) ---- */

static int ja;
/* The Prompt is a terminal ($TERM set, not dumb): what draws on a screen runs here. */
static int screen;
static u32 width = 80;
static const char *table_at, *pages_at;

/* Whether `s` starts with `prefix` (a byte at a time: a literal has no SLACK after it to read a word in). */
static int starts(const char *s, const char *prefix) {
  while (*prefix && *s == *prefix) s++, prefix++;
  return !*prefix;
}
/* The value of `key` (with its =) among envp, or 0. */
static const char *env(char **envp, const char *key) {
  for (; *envp; envp++)
    if (starts(*envp, key)) return *envp + slen(key);
  return 0;
}

/* ---- Reading a file whole (or its first `most` bytes) into the arena: its bytes and length, or 0 when it is not there. */

static u8 *slurp(const char *path, u64 most, u64 *len) {
  i64 fd = sys3(SYS_open, (i64)path, O_RDONLY | O_CLOEXEC, 0);
  if (fd < 0) return 0;
  __attribute__((uninitialized)) struct kstat st;
  u64 size = sys2(SYS_fstat, fd, (i64)&st) < 0 ? most : (u64)st.size < most ? (u64)st.size : most;
  u8 *p = grab(size + 1);
  u64 n = 0;
  while (n < size) {
    i64 r = sys3(SYS_read, fd, (i64)(p + n), (i64)(size - n));
    if (r == -EINTR) continue;
    if (r <= 0) break;
    n += (u64)r;
  }
  sys1(SYS_close, fd);
  p[n] = 0;
  *len = n;
  return p;
}

/* ---- The table: a line a command, name, kind, mark, and why or what instead, by tabs. ---- */

struct row { const u8 *name, *kind, *why; u32 namen, kindn, whyn; u8 mark; };
#define ROWS 1024
static struct row rows[ROWS];
static u32 nrows;

static void read_table(void) {
  u64 n;
  u8 *t = slurp(table_at, 1 << 20, &n);
  if (!t) return;
  for (u64 i = 0; i < n && nrows < ROWS;) {
    u64 e = i;
    while (e < n && t[e] != '\n') e++;
    if (t[i] != '#' && e > i) {
      const u8 *f[4] = {0};
      u32 fl[4] = {0}, k = 0;
      u64 s = i;
      for (u64 j = i; j <= e && k < 4; j++)
        if (j == e || t[j] == '\t') f[k] = t + s, fl[k++] = (u32)(j - s), s = j + 1;
      if (k >= 3 && fl[2] == 1)
        rows[nrows++] = (struct row){f[0], f[1], f[3], fl[0], fl[1], k == 4 ? fl[3] : 0, *f[2]};
    }
    i = e + 1;
  }
}

/* Whether the n bytes at `p` are the string `s`, whole. */
static int is(const u8 *p, u32 n, const char *s) {
  u32 i = 0;
  while (i < n && s[i] && p[i] == (u8)s[i]) i++;
  return i == n && !s[i];
}
static struct row *find(const char *name) {
  for (u32 i = 0; i < nrows; i++)
    if (is(rows[i].name, rows[i].namen, name)) return &rows[i];
  return 0;
}

/* ---- Saying it ---- */

static void say(const char *s) { put(s, slen(s)); }
static void say_n(const u8 *s, u64 n) { put(s, n); }
/* A row's mark as it holds here: one that draws on a screen runs where the Prompt is a terminal. */
static u8 here(u8 m) { return m == 't' && screen ? '+' : m; }
static const char *mark_of(u8 m) { return m == '+' ? "✓" : m == 't' ? "▢" : m == 'x' ? "✗" : "—"; }
/* Each kind as the table names it, then as it is shown in English and in Japanese: one string, each part ended by a
 * zero (a table of pointers would be something to relocate). */
static const char KINDS[] =
  "core\0core\0基本\0files\0files\0ファイル\0text\0text\0テキスト\0search\0search\0探す\0terminal\0terminal\0端末\0"
  "inspect\0inspect\0中を見る\0checksum\0checksum\0検査値\0archives\0archives\0アーカイブ\0data\0data\0データ\0"
  "network\0network\0ネットワーク\0editor\0editor\0エディタ\0development\0develop\0開発\0process\0process\0プロセス\0"
  "debug\0debug\0デバッグ\0shell\0shell\0シェル\0builtin\0builtins\0組み込み\0";
static const char *kind_name(const u8 *k, u32 n) {
  for (const char *s = KINDS; s < KINDS + sizeof KINDS - 1;) {
    const char *shown = s + slen(s) + 1, *jp = shown + slen(shown) + 1;
    if (is(k, n, s)) return ja ? jp : shown;
    s = jp + slen(jp) + 1;
  }
  return 0;
}
/* Columns a string takes: a byte that does not continue a character is one (the kinds' names in Japanese, two). */
static u32 cols(const char *s) {
  u32 c = 0;
  for (const u8 *p = (const u8 *)s; *p; p++) c += (*p & 0xc0) != 0x80 ? (*p >= 0xe3 ? 2 : 1) : 0;
  return c;
}

/* The catalog: each kind on its lines, its names under each mark, wrapped at the width. */
static void catalog(void) {
  if (!nrows) fail("no table of what runs here: ", table_at);
  if (screen) say(ja ? "ここで動くもの: ✓ 動く  ✗ まだ動かない  — この root に無い\n\n"
                     : "What runs here: ✓ runs  ✗ not yet here  — not in this root\n\n");
  else say(ja ? "ここで動くもの: ✓ 動く  ▢ 端末が要る  ✗ まだ動かない  — この root に無い\n\n"
              : "What runs here: ✓ runs  ▢ needs a terminal  ✗ not yet here  — not in this root\n\n");
  static const u8 order[] = {'+', 't', 'x', '-'};
  for (u32 i = 0; i < nrows;) {
    u32 j = i;
    while (j < nrows && rows[j].kindn == rows[i].kindn && !memcmp(rows[j].kind, rows[i].kind, rows[i].kindn)) j++;
    const char *kind = kind_name(rows[i].kind, rows[i].kindn);
    if (!kind) { i = j; continue; }
    u32 first = 1;
    for (u32 o = 0; o < sizeof order; o++) {
      u32 col = 0, any = 0;
      for (u32 r = i; r < j; r++) {
        if (here(rows[r].mark) != order[o]) continue;
        if (!any) {
          say(first ? kind : "");
          for (u32 c = first ? cols(kind) : 0; c < 13; c++) say(" ");
          say(mark_of(order[o]));
          col = 15, any = 1, first = 0;
        }
        if (col + 1 + rows[r].namen > width && col > 15) { say("\n              "); col = 14; }
        say(" "), say_n(rows[r].name, rows[r].namen);
        col += 1 + rows[r].namen;
      }
      if (any) say("\n");
    }
    i = j;
  }
  say(ja ? "\notter 名前: それが何か、ここで動くか。otter -k 言葉: それに関わるもの。\nどのプログラムも --help で使い方を、tldr 名前 でよくある使い方を言います。\n"
         : "\notter NAME: what it is and whether it runs here. otter -k WORD: what is about WORD.\nEach program says how it is used with --help, and tldr NAME shows its common uses.\n");
}

/* ---- What a thing is: its tldr page's lines after `> `, but the one that only links. ---- */

/* The page of `name` in `lang` (common's, then linux's): into the arena; 0 if none. */
/* `s` put at the end of the path being made (n bytes so far, of at most 4000). */
static void add(u8 *path, u64 *n, const char *s) {
  for (; *s && *n < 4000; s++) path[(*n)++] = (u8)*s;
  path[*n] = 0;
}
static u8 *page(const char *name, const char *lang, u64 *len) {
  for (u32 d = 0; d < 2; d++) {
    u8 *path = grab(4096);
    u64 n = 0;
    add(path, &n, pages_at), add(path, &n, "/pages."), add(path, &n, lang), add(path, &n, d ? "/linux/" : "/common/");
    add(path, &n, name), add(path, &n, ".md");
    u8 *p = slurp((const char *)path, 4096, len);
    if (p) return p;
  }
  return 0;
}

/* The words `name` is said in, each line of them by `each`: from the person's language's page, else English. */
static u32 words_of(const char *name, void (*each)(const u8 *, u64, u32)) {
  u64 n = 0;
  u8 *p = ja ? page(name, "ja", &n) : 0;
  if (!p) p = page(name, "en", &n);
  if (!p) return 0;
  u32 said = 0;
  for (u64 i = 0; i < n;) {
    u64 e = i;
    while (e < n && p[e] != '\n') e++;
    if (e - i > 2 && p[i] == '>' && p[i + 1] == ' ') {
      int link = 0;
      for (u64 j = i; j + 5 <= e; j++) if (starts((const char *)p + j, "<http")) { link = 1; break; }
      if (!link) each(p + i + 2, e - i - 2, said++);
    } else if (said) break;
    i = e + 1;
  }
  return said;
}

static void line_described(const u8 *s, u64 n, u32 k) {
  if (k) say("\n       ");
  say_n(s, n);
}
static void first_line(const u8 *s, u64 n, u32 k) { if (!k) say_n(s, n); }

/* Whether `name` is a program of the root (in /usr/bin or /usr/sbin). */
static int program(const char *name) {
  for (u32 d = 0; d < 2; d++) {
    u8 *path = grab(4096);
    u64 n = 0;
    add(path, &n, d ? "/usr/sbin/" : "/usr/bin/"), add(path, &n, name);
    __attribute__((uninitialized)) struct kstat st;
    if (sys4(SYS_newfstatat, AT_FDCWD, (i64)path, (i64)&st, 0) == 0) return 1;
  }
  return 0;
}

/* `otter NAME`: what it is, whether it runs here, and more. 1 if nothing is known of it. */
static int describe(const char *name) {
  struct row *r = find(name);
  say(name);
  say(" - ");
  u32 lines = words_of(name, line_described);
  if (!lines) say(ja ? "(説明のページがありません)" : "(no page says what it is)");
  say("\n  ");
  int known = 1;
  if (r) {
    u8 m = here(r->mark);
    say(mark_of(m));
    say(" ");
    if (m == '+') say(ja ? "ここで動きます" : "runs here");
    else if (m == 't') say(ja ? "あります。画面を描くので、出力だけを見せるこの Prompt では使えません。SSH で手元の端末から使えます (root3 address)"
                                    : "here; it draws on a screen, and this Prompt shows output only: use it from a terminal over SSH (root3 address)");
    else if (m == 'x') { say(ja ? "root にありますが、ここではまだ動きません: " : "in the root, not yet running here: "); say_n(r->why, r->whyn); }
    else {
      say(ja ? "この root にはありません" : "not in this root");
      if (r->whyn) { say(ja ? "。代わりに: " : "; instead: "); say_n(r->why, r->whyn); }
    }
  } else if (program(name)) say(ja ? "root にあります (動くかは試されていません)" : "in the root (not tried by the table)");
  else { say(ja ? "— この root にはありません" : "— not in this root"); known = lines > 0; }
  if (r ? r->mark != '-' : program(name)) {
    say(ja ? "\n  詳しく: " : "\n  more: ");
    say(name); say(" --help; tldr "); say(name);
  }
  say("\n");
  return !known;
}

/* whatis: `NAME (1) - what it is`, or that there is nothing. */
static int whatis(const char *name) {
  u64 mark = used;
  say(name);
  say(" (1) - ");
  u32 had = words_of(name, first_line);
  if (!had) {
    niov -= 2;
    used = mark;
    say(name);
    say(": nothing appropriate.");
  }
  say("\n");
  return !had;
}

/* ---- apropos: the programs whose name or first line holds a word, case aside, sorted by name. ---- */

struct linux_dirent64 { u64 ino; i64 off; u16 reclen; u8 type; char name[]; };

static int holds(const u8 *s, u64 n, const u8 *word, u32 wn) {
  if (wn > n) return 0;
  for (u64 i = 0; i + wn <= n; i++) {
    u32 k = 0;
    while (k < wn && (s[i + k] | (s[i + k] >= 'A' && s[i + k] <= 'Z' ? 0x20 : 0)) == word[k]) k++;
    if (k == wn) return 1;
  }
  return 0;
}

static const u8 *found_words;
static u64 found_len;
static void keep_first(const u8 *s, u64 n, u32 k) { if (!k) found_words = s, found_len = n; }

static int apropos(char **words, int nwords) {
  u8 *lw[64];
  u32 lwn[64];
  if (nwords > 64) nwords = 64;
  for (int w = 0; w < nwords; w++) {
    lwn[w] = (u32)slen(words[w]);
    lw[w] = grab(lwn[w]);
    lower(lw[w], (const u8 *)words[w], lwn[w]);
  }
  /* Every name of the root's programs, once: in /usr's folders and in / 's (a machine whose /bin is not /usr/bin keeps
   * some there, Alpine's ls among them). */
  const char *names[2048];
  u32 nn = 0;
  for (const char *dir = "/usr/bin\0/usr/sbin\0/bin\0/sbin\0"; *dir; dir += slen(dir) + 1) {
    i64 fd = sys3(SYS_open, (i64)dir, O_RDONLY | O_CLOEXEC | 0200000 /* O_DIRECTORY */, 0);
    if (fd < 0) continue;
    for (;;) {
      u8 *buf = grab(32768);
      i64 r = sys3(SYS_getdents64, fd, (i64)buf, 32768);
      if (r <= 0) break;
      for (i64 o = 0; o < r;) {
        struct linux_dirent64 *e = (struct linux_dirent64 *)(buf + o);
        o += e->reclen;
        if (e->name[0] == '.' || nn == sizeof names / sizeof names[0]) continue;
        int dup = 0;
        for (u32 k = 0; k < nn && !dup; k++) dup = same(names[k], e->name);
        if (!dup) names[nn++] = e->name;
      }
    }
    sys1(SYS_close, fd);
  }
  /* Sorted by name (insertion: a few hundred). */
  for (u32 i = 1; i < nn; i++) {
    const char *x = names[i];
    u32 j = i;
    for (; j && !(memcmp(names[j - 1], x, slen(x) + 1) < 0); j--) names[j] = names[j - 1];
    names[j] = x;
  }
  u32 hits = 0;
  for (u32 i = 0; i < nn; i++) {
    found_words = 0, found_len = 0;
    u64 mark = used;
    words_of(names[i], keep_first);
    u64 n = slen(names[i]);
    int hit = 0;
    for (int w = 0; w < nwords && !hit; w++)
      hit = holds((const u8 *)names[i], n, lw[w], lwn[w]) || (found_words && holds(found_words, found_len, lw[w], lwn[w]));
    if (!hit) { used = mark; continue; }
    hits++;
    say(names[i]);
    say(" (1) - ");
    if (found_words) say_n(found_words, found_len);
    say("\n");
  }
  if (!hits) {
    for (int w = 0; w < nwords; w++) { say(words[w]); say(": nothing appropriate.\n"); }
    return 16;
  }
  return 0;
}

static int main_(int argc, char **argv, char **envp) {
  const char *lang = env(envp, "LENGTH3_LANG=");
  ja = lang && same(lang, "ja");
  const char *term = env(envp, "TERM=");
  screen = term && *term && !same(term, "dumb");
  const char *c = env(envp, "COLUMNS=");
  if (c) {
    u32 w = 0;
    while (*c >= '0' && *c <= '9') w = w * 10 + (u32)(*c++ - '0');
    if (w >= 40 && w <= 400) width = w;
  }
  const char *t = env(envp, "OTTER_TABLE="), *p = env(envp, "OTTER_PAGES=");
  table_at = t ? t : "/etc/length3/commands";
  pages_at = p ? p : "/usr/share/tldr/tldr-pages";
  const char *self = argv[0] ? argv[0] : UNIT;
  self += last_slash((const u8 *)self, (u32)slen(self)) + (self[0] == '/' || last_slash((const u8 *)self, (u32)slen(self)) ? 1 : 0);
  int mode = same(self, "whatis") ? 'f' : same(self, "apropos") ? 'k' : 0, i = 1;
  if (!mode && i < argc && (same(argv[i], "-f") || same(argv[i], "-k"))) mode = argv[i++][1];
  if (i < argc && same(argv[i], "--")) i++;
  int status = 0;
  if (mode == 'k') {
    if (i >= argc) fail("apropos what?", 0);
    status = apropos(argv + i, argc - i);
  } else if (mode == 'f') {
    if (i >= argc) fail("whatis what?", 0);
    for (; i < argc; i++) if (whatis(argv[i])) status = 16;
  } else {
    read_table();
    if (i >= argc) catalog();
    for (; i < argc; i++) if (describe(argv[i])) status = 1;
  }
  flush();
  return status;
}
