#include <stdint.h>

/* byte_mask8 at half the lane width: one nibble of 0 or F per input bit.
 * The same LIN_CONST + CONV normal form, with the lane width changed. */
uint32_t expand_nibbles8(uint8_t m)
{
    uint32_t r = 0;

    for (unsigned i = 0; i < 8; ++i)
        if ((m >> i) & 1u)
            r |= 0xFu << (4 * i);

    return r;
}
