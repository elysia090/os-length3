#include <stdint.h>

/* Run identifiers: a lane-local POINT step (run starts) followed by the same
 * linear map and convolution as inclusive_rank8. */
uint64_t run_ids8(uint8_t m)
{
    uint8_t starts = m & ~(uint8_t)(m << 1);
    uint64_t r = 0;

    for (unsigned i = 0; i < 8; ++i)
        r |= (uint64_t)__builtin_popcount(
            starts & ((1u << (i + 1)) - 1)) << (8 * i);

    return r;
}
