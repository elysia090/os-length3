#include <stdint.h>

/* CS:APP Data Lab, howManyBits — the fewest bits that can hold x in two's
 * complement.  Zero and minus one both need one; every other value needs its
 * magnitude's width plus a sign bit. */
uint32_t how_many_bits_i32(uint32_t x)
{
    int32_t v = (int32_t)x;
    uint32_t n = 1;

    if (v < 0) v = ~v;
    while (v) { v >>= 1; n += 1; }
    return n;
}
