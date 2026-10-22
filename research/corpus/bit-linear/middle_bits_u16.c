#include <stdint.h>

/* Stanford CS107 bit-manipulation exercise: pull a field out of the middle of
 * a word.  Selecting bits is a GF(2)-linear map, so this is one instruction on
 * any target that can extract — and the shift-and-mask pair is not it. */
uint16_t middle_bits_u16(uint16_t x)
{
    return (x >> 4) & 0xFF;
}
