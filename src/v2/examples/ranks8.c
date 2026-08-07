#include <stdint.h>

/* Exclusive prefix popcount of an 8-bit mask, one count per byte lane.
 * SPEC §1 / §9: 502 solutions remain tied before canonical selection. */
uint64_t ranks8(uint8_t m)
{
    uint64_t r = 0;

    for (unsigned i = 0; i < 8; ++i)
        r |= (uint64_t)__builtin_popcount(
            m & ((1u << i) - 1)) << (8 * i);

    return r;
}
