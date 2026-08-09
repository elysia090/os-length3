#include <stdint.h>

/* Expand a bit mask to 0x00/0xFF byte lanes.
 * lanecode.h: lc_byte_mask8 — PDEP(m, ONES) * 0xFF */
uint64_t byte_mask8(uint8_t m)
{
    uint64_t r = 0;

    for (unsigned i = 0; i < 8; ++i)
        if ((m >> i) & 1)
            r |= 0xFFull << (8 * i);

    return r;
}
