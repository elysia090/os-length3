#include <stdint.h>

/* floatFloat2Int from the CS:APP Data Lab (CMU 15-213): the bit-level
 * equivalent of (int)f, truncating toward zero, with 0x80000000 for anything
 * out of range -- which includes NaN and infinity.
 *
 * The Data Lab uses binary32; this reads a bfloat16, the top sixteen bits of
 * one. The mantissa is shifted by an amount the exponent decides, which is the
 * part no mask or constant shift reproduces. */
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
                print_hex64((uint64_t)float_to_int_bits((uint16_t)x));
                putchar('\n');
            }
            x = 0;
            seen = 0;
            if (c < 0) break;
        }
    }
    return 0;
}
