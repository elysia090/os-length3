#include <stdint.h>

/* byte_mask8 at half the lane width: one nibble of 0 or F per input bit.  The
 * same deposit and multiply, with the lane width changed. */
uint32_t expand_nibbles8(uint8_t m)
{
    uint32_t r = 0;

    for (unsigned i = 0; i < 8; ++i)
        if ((m >> i) & 1u)
            r |= 0xFu << (4 * i);

    return r;
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
                print_hex64((uint64_t)expand_nibbles8((uint8_t)x));
                putchar('\n');
            }
            x = 0;
            seen = 0;
            if (c < 0) break;
        }
    }
    return 0;
}
