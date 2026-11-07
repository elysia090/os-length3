/*
 * Words: what a unit of the kernel/ reads and compares eight bytes at a time, with nothing of the kernel in it. The
 * first of lib's three (word.h, then sys.h, then io.h, each taking the one before it and nothing else).
 *
 * Where a unit reads a word past the end of what it means (eq, lower, line_in, a hash), SLACK bytes are there to be
 * read: what it works in is given to it with that much after it (io.h grab).
 */
#pragma once

typedef unsigned long u64;
typedef long i64;
typedef unsigned int u32;
typedef unsigned short u16;
typedef unsigned char u8;

static inline u64 ld64(const u8 *p) { u64 v; __builtin_memcpy(&v, p, 8); return v; }
static inline u32 ld32(const u8 *p) { u32 v; __builtin_memcpy(&v, p, 4); return v; }
static inline u16 ld16(const u8 *p) { u16 v; __builtin_memcpy(&v, p, 2); return v; }
static inline void st64(u8 *p, u64 v) { __builtin_memcpy(p, &v, 8); }
static inline void st32(u8 *p, u32 v) { __builtin_memcpy(p, &v, 4); }
static inline void st16(u8 *p, u16 v) { __builtin_memcpy(p, &v, 2); }

#define ONES 0x0101010101010101ull
/* Room past the end of all a run works in, for a word read there. */
#define SLACK 8

/* The high bit of each byte of x that is zero, and of no other (exactly: no carry from one byte into the next). */
static inline u64 zeros(u64 x) {
  const u64 low7 = 0x7f7f7f7f7f7f7f7full;
  return ~(((x & low7) + low7) | x | low7);
}
/* A string's length, a word at a time: words read where they are aligned, so none crosses into a page past the
 * string's (the bytes of the first before the string made not zero). */
static u64 slen(const char *s) {
  const u8 *p = (const u8 *)((u64)s & ~7ul);
  u64 z = zeros(ld64(p) | ((1ull << (8 * ((u64)s & 7))) - 1));
  while (!z) p += 8, z = zeros(ld64(p));
  return (u64)(p - (const u8 *)s) + (u64)(__builtin_ctzll(z) >> 3);
}
static int same(const char *a, const char *b) {
  while (*a && *a == *b) a++, b++;
  return *a == *b;
}
/* Whether `a` and `b` agree in their first n bytes, eight at a time (what is read past them, within their SLACK, is
 * masked off). */
static inline int eq(const u8 *a, const u8 *b, u32 n) {
  for (; n >= 8; n -= 8, a += 8, b += 8)
    if (ld64(a) != ld64(b)) return 0;
  return !n || !((ld64(a) ^ ld64(b)) & (~0ull >> (64 - 8 * n)));
}

/* ASCII letters made small, eight bytes at a time: a byte from A to Z, and only such, gains 0x20. Into `d` from `s`,
 * both with SLACK after them (the last word written whole). */
static inline u64 lower8(u64 x) {
  const u64 high = 0x8080808080808080ull;
  u64 low7 = x & ~high;
  u64 ge_a = low7 + (0x80 - 'A') * ONES; /* high bit: >= 'A' */
  u64 gt_z = low7 + (0x80 - 'Z' - 1) * ONES; /* high bit: > 'Z' */
  return x | ((ge_a & ~gt_z & ~x & high) >> 2);
}
static void lower(u8 *d, const u8 *s, u32 n) {
  for (u32 i = 0; i < n; i += 8) st64(d + i, lower8(ld64(s + i)));
}
/* Whether `a` (any case) is `k` (small) in their first n bytes, case aside; both with SLACK after them. */
static inline int eqi(const u8 *a, const u8 *k, u32 n) {
  for (; n >= 8; n -= 8, a += 8, k += 8)
    if (lower8(ld64(a)) != ld64(k)) return 0;
  return !n || !((lower8(ld64(a)) ^ ld64(k)) & (~0ull >> (64 - 8 * n)));
}

/* Where the last / in `p` (n bytes, absolute) is: a word at a time, from the right. */
static u32 last_slash(const u8 *p, u32 n) {
  for (i64 i = n; i > 0;) {
    i64 s = i > 8 ? i - 8 : 0;
    u64 c = zeros(ld64(p + s) ^ ('/' * ONES)) & (~0ull >> (64 - 8 * (i - s)));
    if (c) return (u32)s + ((63 - __builtin_clzll(c)) >> 3);
    i = s;
  }
  return 0;
}
/* Whether `p` (n bytes, SLACK after) has a line's end in it (\n or \r), a word at a time. */
static int line_in(const u8 *p, u32 n) {
  for (u32 i = 0; i < n; i += 8) {
    u64 w = ld64(p + i), c = zeros(w ^ ('\n' * ONES)) | zeros(w ^ ('\r' * ONES));
    if (n - i < 8) c &= ~0ull >> (64 - 8 * (n - i));
    if (c) return 1;
  }
  return 0;
}
