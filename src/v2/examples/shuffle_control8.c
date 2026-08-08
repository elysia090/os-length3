#include <stdint.h>

/* Indices of the set bits, padded with 0xFF.
 * lanecode.h: lc_shuffle_control8 — ~PEXT(~IOTA, byte_mask8(m)) */
uint64_t shuffle_control8(uint8_t m)
{
    uint64_t r = 0;
    unsigned j = 0;

    for (unsigned i = 0; i < 8; ++i)
        if ((m >> i) & 1)
            r |= (uint64_t)i << (8 * j++);

    while (j < 8)
        r |= 0xFFull << (8 * j++);

    return r;
}
