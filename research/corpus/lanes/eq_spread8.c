#include <stdint.h>

/* Which of the eight byte lanes equals a fixed byte, as a 0x80 flag per lane.
 * The comma is the separator a CSV scanner looks for.
 * lanecode.h: LC_EQ_SPREAD — lc_zero_spread(x ^ c * ONES) */
uint64_t eq_spread8(uint64_t x)
{
    uint64_t s = 0;

    for (unsigned i = 0; i < 8; ++i)
        if (((x >> (8 * i)) & 0xFF) == ',')
            s |= 0x80ull << (8 * i);

    return s;
}
