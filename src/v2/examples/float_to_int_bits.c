#include <stdint.h>

/* CS:APP Data Lab, floatFloat2Int — (int)f for f a bfloat16, truncating
 * toward zero, with 0x80000000 for anything out of range.
 *
 * The shift is by the exponent, and a shift by a value is not a shift by a
 * constant: this is the kernel that says where the declared grammar stops. */
uint32_t float_to_int_bits(uint16_t x)
{
    unsigned sign = (x >> 15) & 1u;
    int exp = (int)((x >> 7) & 0xFFu) - 127;
    uint32_t frac = (uint32_t)(x & 0x7Fu) | 0x80u;
    uint32_t v;

    if (exp < 0) return 0u;
    if (exp > 30) return 0x80000000u;

    if (exp >= 7) v = frac << (exp - 7);
    else          v = frac >> (7 - exp);

    return sign ? (uint32_t)(-(int32_t)v) : v;
}
