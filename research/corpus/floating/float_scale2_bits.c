#include <stdint.h>

/* Adapted from CS:APP Data Lab floatScale2 for bfloat16 input: the top
 * sixteen bits of a binary32, sign, eight exponent bits and seven of mantissa.
 *
 * The case analysis is the exercise.  A denormal doubles by shifting its
 * mantissa, a normal one by incrementing its exponent, the last finite
 * exponent overflows to infinity, and a NaN comes back untouched — four
 * different programs chosen by one comparison on a field. */
uint16_t float_scale2_bits(uint16_t x)
{
    uint16_t sign = x & 0x8000u;
    unsigned exp = (x >> 7) & 0xFFu;
    unsigned man = x & 0x7Fu;

    if (exp == 0xFFu) return x;                              /* inf or NaN  */
    if (exp == 0u)    return (uint16_t)(sign | (man << 1));  /* denormal    */
    if (exp == 0xFEu) return (uint16_t)(sign | 0x7F80u);     /* overflows   */
    return (uint16_t)(x + 0x80u);                            /* exp + 1     */
}
