#include <stdint.h>

/* Inclusive prefix parity over all 64 input coordinates. Each output bit is
 * the GF(2) sum of the input prefix ending at that coordinate. */
uint64_t prefix_parity64(uint64_t x)
{
    uint64_t r = 0;
    uint64_t mask = 0;

    for (unsigned i = 0; i < 64; ++i) {
        mask |= 1ull << i;
        r |= (uint64_t)__builtin_parityll(x & mask) << i;
    }

    return r;
}
