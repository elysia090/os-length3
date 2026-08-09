#include <stdint.h>

/* Population count -- the number of set bits -- from the Bit Hacks lecture of
 * MIT 6.172, Performance Engineering of Software Systems, written as the loop
 * nobody ships. */
uint32_t popcount_u64(uint64_t x)
{
    uint32_t n = 0;

    for (unsigned i = 0; i < 64; ++i)
        n += (uint32_t)((x >> i) & 1u);
    return n;
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
                print_hex64((uint64_t)popcount_u64((uint64_t)x));
                putchar('\n');
            }
            x = 0;
            seen = 0;
            if (c < 0) break;
        }
    }
    return 0;
}
