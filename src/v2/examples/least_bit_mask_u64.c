#include <stdint.h>

/* MIT 6.172 — a mask with only the lowest set bit of x in it. */
uint64_t least_bit_mask_u64(uint64_t x)
{
    for (unsigned i = 0; i < 64; ++i)
        if ((x >> i) & 1u)
            return (uint64_t)1 << i;
    return 0;
}
