#include <stdint.h>

/* Widen each per-lane flag to a whole 00/FF byte.
 * lanecode.h: lc_byte_mask_from_spread — (s >> 7) * 0xFF
 *
 * The six dead bits between the flags stop this being a convolution, so the
 * canonical form keeps them: mask, slide down, multiply. */
uint64_t byte_mask_from_spread(uint64_t s)
{
    uint64_t r = 0;

    for (unsigned i = 0; i < 8; ++i)
        if ((s >> (8 * i + 7)) & 1ull)
            r |= 0xFFull << (8 * i);

    return r;
}
