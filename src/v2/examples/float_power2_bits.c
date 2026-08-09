#include <stdint.h>

/* floatPower2 from the CS:APP Data Lab (CMU 15-213), which asks for the
 * bit-level equivalent of 2.0^x as an IEEE-754 binary32: zero when the result
 * is too small to be a denormal, +infinity when it is too large.
 *
 * x is read as a signed byte here, so the exponent lands between -128 and 127
 * and the "too large" case cannot arise; the two smallest powers do come out
 * as denormals. */
uint32_t float_power2_bits(uint8_t x)
{
    int e = (int)(int8_t)x + 127;

    if (e >= 255) return 0x7F800000u;       /* too large: +infinity   */
    if (e > 0)    return (uint32_t)e << 23; /* a normal number        */
    if (e > -23)  return 1u << (22 + e);    /* a denormal             */
    return 0u;                              /* too small even for one */
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
                print_hex64((uint64_t)float_power2_bits((uint8_t)x));
                putchar('\n');
            }
            x = 0;
            seen = 0;
            if (c < 0) break;
        }
    }
    return 0;
}
