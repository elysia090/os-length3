#include <stdint.h>

/* Inclusive prefix popcount.  The boundary condition removes the trailing-zero
 * freedom of ranks8, so the physical constants are uniquely forced. */
uint64_t inclusive_rank8(uint8_t m)
{
    uint64_t r = 0;

    for (unsigned i = 0; i < 8; ++i)
        r |= (uint64_t)__builtin_popcount(
            m & ((1u << (i + 1)) - 1)) << (8 * i);

    return r;
}
