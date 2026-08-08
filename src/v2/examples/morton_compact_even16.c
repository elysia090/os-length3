#include <stdint.h>

/* Gather the even bit positions.
 * lanecode.h: lc_morton_compact_even — PEXT with a 0x5555... mask */
uint8_t morton_compact_even16(uint16_t x)
{
    uint8_t r = 0;

    for (unsigned i = 0; i < 8; ++i)
        if ((x >> (2 * i)) & 1)
            r |= (uint8_t)(1u << i);

    return r;
}
