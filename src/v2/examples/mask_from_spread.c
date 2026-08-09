#include <stdint.h>

/* Collect the per-lane flags back into an 8-bit mask: the integer half of
 * what a vector MOVEMASK does, and a bit extract in one instruction on a
 * machine that has one. */
uint8_t mask_from_spread(uint64_t s)
{
    uint8_t m = 0;

    for (unsigned i = 0; i < 8; ++i)
        m |= (uint8_t)(((s >> (8 * i + 7)) & 1ull) << i);

    return m;
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
                print_hex64((uint64_t)mask_from_spread((uint64_t)x));
                putchar('\n');
            }
            x = 0;
            seen = 0;
            if (c < 0) break;
        }
    }
    return 0;
}
