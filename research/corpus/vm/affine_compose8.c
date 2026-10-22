#include <stdint.h>

/* Distribution removes the intermediate subtraction:
 *
 *     (x - c) * 255 = 255*x - 255*c  (mod 2^64).
 *
 * This three-operation source therefore has a two-operation closed form. */
uint64_t affine_compose8(uint8_t x)
{
    uint64_t value = (uint64_t)x - 0x5555555555555555ull;

    value |= 0;
    return value * 255ull;
}
