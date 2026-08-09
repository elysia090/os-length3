#include <stdint.h>

/* Run identifiers: every bit gets the number of the run of ones it belongs
 * to.  A run starts where a set bit follows a clear one, and numbering the
 * runs is then the same prefix count as inclusive_rank8. */
uint64_t run_ids8(uint8_t m)
{
    uint8_t starts = m & ~(uint8_t)(m << 1);
    uint64_t r = 0;

    for (unsigned i = 0; i < 8; ++i)
        r |= (uint64_t)__builtin_popcount(
            starts & ((1u << (i + 1)) - 1)) << (8 * i);

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
                print_hex64((uint64_t)run_ids8((uint8_t)x));
                putchar('\n');
            }
            x = 0;
            seen = 0;
            if (c < 0) break;
        }
    }
    return 0;
}
