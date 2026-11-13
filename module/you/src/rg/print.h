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
  if (!(o.filename && !o.heading) && !o.number && !col && !o.byte_offset) return;
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
/* Whether the line t[ls..le) about to be printed holds a NUL, and where. Looked for as lines are printed and no
 * sooner: what is not printed is never looked at for one (a count, a file's name, a search that finds little pass
 * over the text once, not twice). A line printed by itself is looked at by itself; where lines are printed one
 * right after another, the look goes on ahead of them, twice as far each time up to 4 KiB, so a text printed whole
 * is looked at 64 bytes a step and not line by line. t[nul_from..nul_to) is what was looked over last, nul_at the
 * first NUL in it (or text_n). */
static u64 nul_from, nul_to, nul_at, nul_ahead;
static u64 nul_in(const u8 *t, u64 ls, u64 le) {
  if (ls < nul_from || ls > nul_to || nul_at < ls) nul_from = nul_to = ls, nul_at = text_n, nul_ahead = 0; /* (nothing known from here) */
  if (le > nul_to && nul_at == text_n) {
    u64 to = nul_to + nul_ahead > le ? nul_to + nul_ahead : le;
    if (to > text_n) to = text_n;
    u64 z = first_nul(t + nul_to, to - nul_to);
    if (z < to - nul_to) nul_at = nul_to + z;
    nul_to = to;
    nul_ahead = nul_ahead ? (nul_ahead < 4096 ? 2 * nul_ahead : 4096) : 64;
  }
  return nul_at < le ? nul_at : le;
}
static int span(u64 ls, u64 le, u64 *x, u64 *last, u64 *ms, u64 *me);
/* The line t[ls..le) printed as one that holds a match (`sep` ':') or one around it ('-'). */
static void print_line(const u8 *t, u64 ls, u64 le, u64 lnum, u8 sep) {
  head();
  separate(lnum);
  if (convert) {
    u64 z = nul_in(t, ls, le);
    if (z < le) {
      if (o.filename && !o.heading) { put_path(); S(": "); }
      S("binary file matches (found \"\\0\" byte around offset ");
      putn(z);
      S(")\n");
      bin_hit = 1;
      return;
    }
  }
  printed_any = 1, last_printed = lnum;
  u64 x = ls, last = ~0ull, ms, me;
  if (sep == ':' && (o.only || o.vimgrep || o.column)) {
    int any = 0;
    while (span(ls, le, &x, &last, &ms, &me)) {
      /* (An empty match is printed too, -o: an empty line, as ripgrep prints it.) */
      any = 1;
      prefix(lnum, o.column || o.vimgrep ? ms - ls + 1 : 0, o.only ? ms : ls, sep);
      if (o.only) {
        if (!o.colour && !o.replace) { put_line(t + ms, me - ms); continue; }
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
    while (span(ls, le, &x, &last, &ms, &me)) {
      if ((ms == me && !o.replace) || ms < at) continue;
      put(t + at, ms - at);
      if (o.colour) S(MATCH_IN);
      o.replace ? replaced(t, ms, me) : put(t + ms, me - ms);
      if (o.colour) S(OUT);
      at = me;
    }
    put(t + at, le - at);
  } else if (le < text_n && le - from >= SMALL) { put(t + from, le + 1 - from); return; } /* (its line feed with it, from the text: one piece) */
  else put(t + from, le - from);
  S("\n");
}

/* The first match on the line at first_ls, as next_match found it, handed to the first walk of that line's matches
 * (span), which goes on from it: no match is looked for twice. */
static u64 first_ls = ~0ull, first_x, first_last, first_ms, first_me;
/* The next line that holds a match (its start), or n: re/grep.h's, each line it gives checked where it may hold none
 * (spans: its first match found, and kept for the line's printing). */
static u64 next_match(const u8 *t, u64 n) {
  for (;;) {
    u64 ls = grep_line(&g);
    if (ls >= n || !spans) return ls;
    u64 le = line_end(t, n, ls), x = ls, last = ~0ull, ms, me;
    if (grep_span(&g, ls, le, &x, &last, &ms, &me)) {
      first_ls = ls, first_x = x, first_last = last, first_ms = ms, first_me = me;
      return ls;
    }
  }
}
/* The next match on the line t[ls..le) (grep_span), the first one as next_match found it when it is asked from the
 * line's start. */
static int span(u64 ls, u64 le, u64 *x, u64 *last, u64 *ms, u64 *me) {
  if (ls == first_ls && *x == ls && *last == ~0ull) {
    first_ls = ~0ull;
    *x = first_x, *last = first_last, *ms = first_ms, *me = first_me;
    return 1;
  }
  return grep_span(&g, ls, le, x, last, ms, me);
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
  nul_from = nul_to = 0, nul_at = n, nul_ahead = 0; /* (a printed line is looked at for a NUL as it is printed: nul_in) */
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
  grep_all(&g, n);
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
    if (o.count_matches) for (u64 x = ls, last = ~0ull, ms, me; span(ls, le, &x, &last, &ms, &me);) matches++;
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
#define READ_AT_ONCE (256u << 10)
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
      /* A large file's pages read in at once (MADV_POPULATE_READ; a kernel without it: as each is first touched), not
       * one fault a page as the search comes to it. Where more threads than one will search it, only what the first
       * searches alone: each thread reads in the pieces it takes (re/grep.h). */
      u64 alone = g.most > 1 && (u64)st.size > (8u << 20) ? 2u << 20 : (u64)st.size;
      if ((u64)st.size >= READ_AT_ONCE) sys3(SYS_madvise, m, (i64)alone, 22);
      found |= search_text((const u8 *)m, (u64)st.size, named);
      flush();
      sys2(SYS_munmap, m, st.size);
    }
  }
  sys1(SYS_close, fd);
}
