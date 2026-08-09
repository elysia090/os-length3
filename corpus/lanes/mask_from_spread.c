#include <stdint.h>

/* Collect the high bit of each byte lane into an 8-bit mask. This is the
 * integer analogue of MOVEMASK and can be implemented with PEXT. */
uint8_t mask_from_spread(uint64_t s)
{
    uint8_t m = 0;

    for (unsigned i = 0; i < 8; ++i)
        m |= (uint8_t)(((s >> (8 * i + 7)) & 1ull) << i);

    return m;
}
