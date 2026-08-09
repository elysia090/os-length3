#include <stdint.h>

/* Which byte lanes are zero — the end-of-string test, exactly rather than
 * approximately.  The well-known (v - ONES) & ~v & HIGH is not this function:
 * a borrow reaches into an adjacent 0x01 lane and reports it as zero.
 * lanecode.h: lc_zero_spread */
uint64_t zero_spread8(uint64_t x)
{
    uint64_t s = 0;

    for (unsigned i = 0; i < 8; ++i)
        if (((x >> (8 * i)) & 0xFF) == 0)
            s |= 0x80ull << (8 * i);

    return s;
}
