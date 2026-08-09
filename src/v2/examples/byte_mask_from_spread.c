#include <stdint.h>

/* Widen each per-lane flag, which sits in the high bit of its byte, to the
 * whole byte.  Written by hand as `(s >> 7) * 0xFF`, which is exact only
 * because its caller guarantees the other seven bits of each lane are clear;
 * stated on its own it needs the mask as well. */
uint64_t byte_mask_from_spread(uint64_t s)
{
    uint64_t r = 0;

    for (unsigned i = 0; i < 8; ++i)
        if ((s >> (8 * i + 7)) & 1ull)
            r |= 0xFFull << (8 * i);

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
                print_hex64((uint64_t)byte_mask_from_spread((uint64_t)x));
                putchar('\n');
            }
            x = 0;
            seen = 0;
            if (c < 0) break;
        }
    }
    return 0;
}
