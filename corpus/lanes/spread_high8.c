#include <stdint.h>

/* One flag per byte lane, in the high bit — the shape every lanecode.h
 * predicate produces.  The two *_from_spread examples consume it. */
uint64_t spread_high8(uint8_t m)
{
    uint64_t r = 0;

    for (unsigned i = 0; i < 8; ++i)
        if ((m >> i) & 1u)
            r |= 0x80ull << (8 * i);

    return r;
}
