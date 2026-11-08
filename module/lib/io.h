/*
 * What a run works in and what it says: one arena, used from its start as far as the run needs and no further (so it
 * touches the pages its own data reaches and no others); what it writes to standard output, gathered and written by
 * one writev; and how it fails. The last of lib's three (word.h, then sys.h, then this).
 */
#pragma once
#include "sys.h"

/* What a run works in, used from its start and as far as it needs: what it is given is SLACK past what it asks for.
 * Taken at once (an atomic add), so threads (sys.h spawn) take from it side by side. */
#ifndef ARENA
#define ARENA (1 << 21)
#endif
static u8 arena[ARENA];
static u64 used;
static u8 *grab(u64 n) {
  u64 size = (n + SLACK + 15) & ~15ul, at = __atomic_fetch_add(&used, size, __ATOMIC_RELAXED);
  u8 *p = arena + at;
  if (at + size > sizeof arena) {
    static const char m[] = UNIT ": out of room\n";
    sys3(SYS_write, 2, (i64)m, sizeof m - 1);
    leave(1);
  }
  return p;
}
#define LEFT (sizeof arena - used)

/* What is written to standard output: pieces of what is already in memory, not copied, and pieces made to be written
 * (a number, in `text`, 32 bytes each, at most one piece in two), gathered and written by one writev each IOV of them. */
struct iovec { const void *base; u64 len; };
#define IOV 1024
static struct iovec iov[IOV];
static u32 niov;
static u8 text[IOV / 2 * 32];
static u64 textn;
static void flush(void) {
  struct iovec *v = iov;
  for (u32 k = niov; k;) {
    i64 r = sys3(SYS_writev, 1, (i64)v, k);
    if (r == -EINTR) continue;
    if (r <= 0) leave(1);
    for (; k && (u64)r >= v->len; v++, k--) r -= (i64)v->len;
    if (k) v->base = (const u8 *)v->base + r, v->len -= (u64)r; /* written in part: the rest */
  }
  niov = 0, textn = 0;
}
static void put(const void *p, u64 n) {
  iov[niov].base = p, iov[niov++].len = n;
  if (niov == IOV) flush();
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
