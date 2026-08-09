#include <stdint.h>

/* Rounding up to a power of two, from the Bit Hacks lecture of MIT 6.172,
 * Performance Engineering of Software Systems: decrement, propagate the
 * highest set bit down over the whole width, increment.
 *
 * Stated here as the loop it replaces. Zero is not rounded up to anything, and
 * a value above 2^63 has nothing in range to round up to, so both answer
 * zero -- which is what the shift-and-or form does as well. */
uint64_t round_up_pow2_u64(uint64_t x)
{
    uint64_t n = 0;

    if (x != 0) {
        n = 1;
        for (unsigned i = 0; i < 64; ++i)
            if (n < x) n <<= 1;
    }
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
                print_hex64((uint64_t)round_up_pow2_u64((uint64_t)x));
                putchar('\n');
            }
            x = 0;
            seen = 0;
            if (c < 0) break;
        }
    }
    return 0;
}
