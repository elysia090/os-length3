#include <stdint.h>

/* Exclusive prefix population counts in sixteen four-bit lanes. */
uint64_t ranks16_nibble(uint16_t m)
{
    uint64_t r = 0;

    for (unsigned i = 0; i < 16; ++i)
        r |= (uint64_t)__builtin_popcount(
            m & ((1u << i) - 1)) << (4 * i);

    return r;
}
