/* A bounded arena, without the buffered-output layer. Shared by C programs that need storage alone. */
#pragma once
#include "sys.h"

/* What a run works in, used from its start and as far as it needs: what it is given is SLACK past what it asks for.
 * Taken at once (an atomic add), so threads (sys.h spawn) take from it side by side. */
#ifndef ARENA
#define ARENA (1 << 21)
#endif
static u8 arena[ARENA];
static u64 used;
static inline u8 *grab(u64 n) {
  const u64 capacity = sizeof arena & ~15ull;
  if (n > capacity - SLACK) goto full;
  u64 size = (n + SLACK + 15) & ~15ull;
#ifdef ARENA_SERIAL
  u64 at = used;
  used += size;
#else
  u64 at = __atomic_fetch_add(&used, size, __ATOMIC_RELAXED);
#endif
  if (at > capacity || size > capacity - at) goto full;
  return arena + at;
full: {
    static const char m[] = UNIT ": out of room\n";
    sys3(SYS_write, 2, (i64)m, sizeof m - 1);
    leave(1);
  }
}
#define LEFT (sizeof arena - used)
