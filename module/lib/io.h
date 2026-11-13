/*
 * What a run works in and what it says: one arena, used from its start as far as the run needs and no further (so it
 * touches the pages its own data reaches and no others); what it writes to standard output, gathered and written by
 * one writev; and how it fails. The last of lib's three (word.h, then sys.h, then this).
 */
#pragma once
#include "arena.h"

/* What is written to standard output: pieces of what is already in memory, not copied, and pieces made to be written
 * (a number, in `text`, 32 bytes each, at most one piece in two), gathered and written by one writev each IOV of them.
 * A small piece (SMALL bytes or fewer: a match, a line feed, a number) is copied into `stage` instead, beside the small
 * pieces before it, so a run of them is one piece of the writev, not one each (the kernel walks every piece it is
 * given: a million matches of a few bytes are a million pieces, else). */
struct iovec { const void *base; u64 len; };
#define IOV 1024
#define SMALL 64
static struct iovec iov[IOV];
static u32 niov;
static u8 text[IOV / 2 * 32];
static u64 textn;
static u8 stage[64 << 10];
static u64 stagen;
static void flush(void) {
  struct iovec *v = iov;
  for (u32 k = niov; k;) {
    i64 r = sys3(SYS_writev, 1, (i64)v, k);
    if (r == -EINTR) continue;
    if (r <= 0) leave(1);
    for (; k && (u64)r >= v->len; v++, k--) r -= (i64)v->len;
    if (k) v->base = (const u8 *)v->base + r, v->len -= (u64)r; /* written in part: the rest */
  }
  niov = 0, textn = 0, stagen = 0;
}
/* p[0..n) (n < SMALL) copied into `stage`, a line feed after it when `nl`, beside the small pieces before it. */
static void staged(const void *p, u64 n, int nl) {
  if (stagen + SMALL + 1 > sizeof stage) flush();
  u8 *d = stage + stagen;
  __builtin_memcpy(d, p, n);
  d[n] = '\n';
  n += (u64)nl, stagen += n;
  if (niov && (const u8 *)iov[niov - 1].base + iov[niov - 1].len == d) { iov[niov - 1].len += n; return; }
  iov[niov].base = d, iov[niov++].len = n;
  if (niov == IOV) flush();
}
static void put(const void *p, u64 n) {
  if (n <= SMALL) { staged(p, n, 0); return; }
  /* (What lies where the piece before it ends is that piece, longer: lines of a text one after another are one piece.) */
  if (niov && (const u8 *)iov[niov - 1].base + iov[niov - 1].len == (const u8 *)p) { iov[niov - 1].len += n; return; }
  iov[niov].base = p, iov[niov++].len = n;
  if (niov == IOV) flush();
}
/* Where what is to be written has got to, to be taken back to (unput) while nothing is written out between: its pieces,
 * the last one's length (a small piece may have been put beside it) and how much of `stage` and `text` is taken. */
struct written { u32 niov; u64 last, stagen, textn; };
static inline struct written written(void) { return (struct written){niov, niov ? iov[niov - 1].len : 0, stagen, textn}; }
static inline void unput(struct written w) {
  niov = w.niov, stagen = w.stagen, textn = w.textn;
  if (niov) iov[niov - 1].len = w.last;
}
/* p[0..n) and a line feed: one copy, where it is small. */
static inline void put_line(const void *p, u64 n) {
  if (n < SMALL) { staged(p, n, 1); return; }
  put(p, n);
  put("\n", 1);
}
/* A piece of `text` to write a number into, from its end (returned) back, then to put: 32 bytes, all of them written
 * out first when every piece is taken. */
static inline u8 *piece(void) {
  if (textn + 32 > sizeof text) flush();
  textn += 32;
  return text + textn;
}

/* What was written so far out, then UNIT: what, about, on standard error; the run ends, 1. */
__attribute__((noreturn, cold)) static inline void fail(const char *what, const char *about) {
  flush();
  __attribute__((uninitialized)) u8 m[600];
  u64 n = 0;
  const char *parts[3] = {UNIT ": ", what, about};
  for (int i = 0; i < 3; i++)
    for (const char *s = parts[i]; s && *s && n < sizeof m - 2; s++) m[n++] = (u8)*s;
  m[n++] = '\n';
  sys3(SYS_write, 2, (i64)m, (i64)n);
  leave(1);
}
