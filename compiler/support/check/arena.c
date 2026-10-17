#include <support/arena.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

int main(void)
{
    _Alignas(8) pl_u8 storage[96];
    unsigned cases = 0;
    for (pl_u32 bias = 0; bias < 8u; ++bias)
    for (pl_u32 size = 0; size <= 40u; ++size)
    for (pl_u32 used = 0; used <= 42u; ++used)
    for (pl_u32 bytes = 0; bytes <= 24u; ++bytes) {
        memset(storage, 0xa5, sizeof storage);
        pl_arena arena = { storage + bias, size, used };
        uintptr_t address = (uintptr_t)arena.base + used;
        pl_u32 padding = (pl_u32)((8u - (address % 8u)) % 8u);
        int fits = used <= size && padding <= size - used
                && bytes <= size - used - padding;
        void *result = pl_arena_take(&arena, bytes);
        if ((result != 0) != fits
                || (result && (uintptr_t)result % 8u)
                || arena.used != (fits ? used + padding + bytes : used)
                || (fits && result != arena.base + used + padding)) {
            fprintf(stderr, "arena mismatch: bias/size/used/bytes=%u/%u/%u/%u\n",
                    bias, size, used, bytes);
            return 1;
        }
        if (fits && bytes >= sizeof(pl_u64)) *(pl_u64 *)result = 42u;
        for (pl_u32 index = 0; index < sizeof storage; ++index)
            if ((!fits || index < bias + used + padding
                    || index >= bias + used + padding + bytes)
                    && storage[index] != 0xa5) return 1;
        pl_arena_reset(&arena);
        if (arena.used) return 1;
        ++cases;
    }
    pl_arena null_base = { 0, 16u, 0u };
    pl_arena limit = { storage, UINT32_MAX, UINT32_MAX };
    if (pl_arena_take(0, 1u) || pl_arena_take(&null_base, 0u)
            || pl_arena_take(&limit, 1u) || limit.used != UINT32_MAX)
        return 1;
    pl_arena_reset(0);
    printf("arena: %u alignment/capacity cases, NULL and overflow boundaries green\n", cases);
    return 0;
}
