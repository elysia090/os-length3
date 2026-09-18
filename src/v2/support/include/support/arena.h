/* Caller-owned, allocation-free bump arena. */

#ifndef SUPPORT_ARENA_H
#define SUPPORT_ARENA_H

#include <support/types.h>

typedef struct {
    pl_u8 *base;
    pl_u32 size;
    pl_u32 used;
} pl_arena;

void pl_arena_reset(pl_arena *arena);
void *pl_arena_take(pl_arena *arena, pl_u32 bytes);

#endif /* SUPPORT_ARENA_H */
