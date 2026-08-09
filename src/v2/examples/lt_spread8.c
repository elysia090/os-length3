#include <stdint.h>

/* Which byte lanes hold a control character, unsigned.  One-sided: the
 * accepted range starts at zero, so only the upper bound is left to test. */
uint64_t lt_spread8(uint64_t x)
{
    uint64_t s = 0;

    for (unsigned i = 0; i < 8; ++i)
        if (((x >> (8 * i)) & 0xFF) < 0x20)
            s |= 0x80ull << (8 * i);

    return s;
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
                print_hex64((uint64_t)lt_spread8((uint64_t)x));
                putchar('\n');
            }
            x = 0;
            seen = 0;
            if (c < 0) break;
        }
    }
    return 0;
}
