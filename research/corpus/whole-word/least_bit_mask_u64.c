#include <stdint.h>

/* MIT 6.172 Lecture 3: isolate the least significant set bit of x. */
uint64_t least_bit_mask_u64(uint64_t x)
{
    for (unsigned i = 0; i < 64; ++i)
        if ((x >> i) & 1u)
            return (uint64_t)1 << i;
    return 0;
}
