#include <stdint.h>

/* Which byte lanes hold an ASCII digit.  Both bounds at once: one subtraction
 * per side, and neither borrow leaves the lane it started in.
 * lanecode.h: LC_RANGE_SPREAD */
uint64_t range_spread8(uint64_t x)
{
    uint64_t s = 0;

    for (unsigned i = 0; i < 8; ++i) {
        unsigned b = (unsigned)((x >> (8 * i)) & 0xFF);

        if (b >= '0' && b <= '9')
            s |= 0x80ull << (8 * i);
    }

    return s;
}
