#include <stdint.h>

/* Expand each input bit to one four-bit lane containing either 0 or 0xF. */
uint32_t expand_nibbles8(uint8_t m)
{
    uint32_t r = 0;

    for (unsigned i = 0; i < 8; ++i)
        if ((m >> i) & 1u)
            r |= 0xFu << (4 * i);

    return r;
}
