#include <stdint.h>

/* Pull a field out of the middle of a word with a mask and a shift, the
 * exercise Stanford's CS107, Computer Organization and Systems, uses to
 * introduce masking.
 *
 * Selecting bits is linear over GF(2), so a machine with a bit-extract
 * instruction does the whole thing in one -- and the shift-and-mask pair the
 * source is written as is not it. */
uint16_t middle_bits_u16(uint16_t x)
{
    return (x >> 4) & 0xFF;
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
                print_hex64((uint64_t)middle_bits_u16((uint16_t)x));
                putchar('\n');
            }
            x = 0;
            seen = 0;
            if (c < 0) break;
        }
    }
    return 0;
}
