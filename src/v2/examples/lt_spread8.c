#include <stdint.h>

/* Which byte lanes hold a control character, unsigned.  One-sided compare:
 * the interval starts at zero, so only the upper bound is left to test.
 * lanecode.h: LC_LT_SPREAD */
uint64_t lt_spread8(uint64_t x)
{
    uint64_t s = 0;

    for (unsigned i = 0; i < 8; ++i)
        if (((x >> (8 * i)) & 0xFF) < 0x20)
            s |= 0x80ull << (8 * i);

    return s;
}
