#include <stdint.h>

/* Collect the per-lane flags back into an 8-bit mask: the integer half of
 * MOVEMASK, and a linear map that PEXT does in one instruction.
 * lanecode.h: lc_mask_from_spread
 *
 * A 64-bit input cannot be enumerated, so the verification here is a
 * differential over the declared domain rather than a proof. */
uint8_t mask_from_spread(uint64_t s)
{
    uint8_t m = 0;

    for (unsigned i = 0; i < 8; ++i)
        m |= (uint8_t)(((s >> (8 * i + 7)) & 1ull) << i);

    return m;
}
