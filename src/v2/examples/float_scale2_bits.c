#include <stdint.h>

/* floatScale2 from the CS:APP Data Lab (CMU 15-213): the bit-level equivalent
 * of 2*f, returning the argument unchanged when it is NaN.
 *
 * The Data Lab uses binary32; this is the same case analysis on a bfloat16 --
 * the top sixteen bits of a binary32, so one sign bit, eight exponent bits and
 * seven of mantissa. A denormal doubles by shifting its mantissa, and carries
 * into the exponent by itself when it becomes normal; a normal number doubles
 * by incrementing its exponent; the last finite exponent overflows to
 * infinity. */
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

/* Reads whitespace-separated hex words from the terminal and prints what the
 * kernel makes of each one. */
int main(void)
{
    uint64_t x = 0;
    int c, seen = 0;

    while (1) {
        c = getchar();
        if (c >= '0' && c <= '9')      { x = x * 16u + (uint64_t)(c - '0');      seen = 1; }
        else if (c >= 'a' && c <= 'f') { x = x * 16u + (uint64_t)(c - 'a' + 10); seen = 1; }
        else if (c >= 'A' && c <= 'F') { x = x * 16u + (uint64_t)(c - 'A' + 10); seen = 1; }
        else {
            if (seen) {
                print_hex64((uint64_t)float_scale2_bits((uint16_t)x));
                putchar('\n');
            }
            x = 0;
            seen = 0;
            if (c < 0) break;
        }
    }
    return 0;
}
