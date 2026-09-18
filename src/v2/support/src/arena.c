#include <support/arena.h>

void pl_arena_reset(pl_arena *arena)
{
    if (arena) arena->used = 0u;
}

void *pl_arena_take(pl_arena *arena, pl_u32 bytes)
{
    pl_u32 at;
    if (!arena || arena->used > ~7u) return 0;
    at = (arena->used + 7u) & ~7u;
    if (at > arena->size || bytes > arena->size - at) return 0;
    arena->used = at + bytes;
    return arena->base + at;
}
