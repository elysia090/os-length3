#include <stdint.h>

/* Adapted from CS:APP Data Lab floatFloat2Int for bfloat16 input: convert to a
 * signed integer by truncating toward zero, and return 0x80000000 when the
 * value is out of range. The exponent determines the shift distance. */
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
