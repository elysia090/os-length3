#include <support/arena.h>
#include <stdint.h>

void pl_arena_reset(pl_arena *arena)
{
    if (arena) arena->used = 0u;
}

void *pl_arena_take(pl_arena *arena, pl_u32 bytes)
{
    if (!arena || !arena->base || arena->used > arena->size) return 0;
    /* Align the address, not just its offset: a caller-owned byte range need
     * not begin on an eight-byte boundary. Only the low address bits enter
     * this calculation, so neither pointer nor offset arithmetic can wrap. */
    pl_u32 residue = (pl_u32)((uintptr_t)arena->base & 7u)
                   + (arena->used & 7u);
    pl_u32 padding = (0u - residue) & 7u;
    if (padding > arena->size - arena->used) return 0;
    pl_u32 at = arena->used + padding;
    if (at > arena->size || bytes > arena->size - at) return 0;
    arena->used = at + bytes;
    return arena->base + at;
}
