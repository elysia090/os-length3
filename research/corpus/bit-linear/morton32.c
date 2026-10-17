#include <stdint.h>

/* Interleave the bits of two independent 32-bit coordinates. */
uint64_t morton32(uint32_t x, uint32_t y)
{
    uint64_t r = 0;

    for (unsigned i = 0; i < 32; ++i) {
        r |= (uint64_t)((x >> i) & 1u) << (2 * i);
        r |= (uint64_t)((y >> i) & 1u) << (2 * i + 1);
    }

    return r;
}
