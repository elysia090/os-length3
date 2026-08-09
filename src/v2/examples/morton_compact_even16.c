#include <stdint.h>

/* Gather the even bit positions down into a byte: the inverse of the Morton
 * dilation, and a bit extract with a 0x5555... mask. */
uint8_t morton_compact_even16(uint16_t x)
{
    uint8_t r = 0;

    for (unsigned i = 0; i < 8; ++i)
        if ((x >> (2 * i)) & 1)
            r |= (uint8_t)(1u << i);

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
                print_hex64((uint64_t)morton_compact_even16((uint16_t)x));
                putchar('\n');
            }
            x = 0;
            seen = 0;
            if (c < 0) break;
        }
    }
    return 0;
}
