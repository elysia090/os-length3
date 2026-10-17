#include <stdint.h>

/* Adapted from Algorithms, 4th Edition, key-indexed counting: count sixteen
 * two-bit keys and place the four independent counts in four byte lanes. */
uint32_t histogram4_u2x16(uint32_t v)
{
    uint32_t out = 0;

    for (unsigned i = 0; i < 16; ++i)
        out += (uint32_t)1 << (8 * ((v >> (2 * i)) & 3u));
    return out;
}
