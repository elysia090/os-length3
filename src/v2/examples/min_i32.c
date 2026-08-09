#include <stdint.h>

/* The branchless minimum of two signed integers, from the Bit Hacks lecture of
 * MIT 6.172, Performance Engineering of Software Systems. The lecture's point
 * is that a mispredicted branch costs more than the arithmetic that avoids it.
 *
 * The two arguments arrive as the high and low halves of one word, because
 * this file states one function of one input. */
uint32_t min_i32(uint64_t ab)
{
    int32_t a = (int32_t)(uint32_t)(ab >> 32);
    int32_t b = (int32_t)(uint32_t)ab;

    return (uint32_t)(a < b ? a : b);
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
                print_hex64((uint64_t)min_i32((uint64_t)x));
                putchar('\n');
            }
            x = 0;
            seen = 0;
            if (c < 0) break;
        }
    }
    return 0;
}
