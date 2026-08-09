#include <stdint.h>

/* Spread 16 bits into the even positions of a 32-bit word.  A pure constant
 * GF(2)-linear map: what varies between targets is the representative. */
uint32_t morton_dilate16(uint16_t x)
{
    uint32_t r = 0;

    for (unsigned i = 0; i < 16; ++i)
        if ((x >> i) & 1)
            r |= 1u << (2 * i);

    return r;
}
