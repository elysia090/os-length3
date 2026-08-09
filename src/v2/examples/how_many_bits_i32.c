#include <stdint.h>

/* howManyBits from the CS:APP Data Lab (CMU 15-213): the least number of bits
 * needed to represent x in two's complement.
 *
 * howManyBits(12) is 5, howManyBits(298) is 10, howManyBits(-5) is 4, and both
 * howManyBits(0) and howManyBits(-1) are 1. */
uint32_t how_many_bits_i32(uint32_t x)
{
    int32_t v = (int32_t)x;
    uint32_t n = 1;

    if (v < 0) v = ~v;
    while (v) { v >>= 1; n += 1; }
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
                print_hex64((uint64_t)how_many_bits_i32((uint32_t)x));
                putchar('\n');
            }
            x = 0;
            seen = 0;
            if (c < 0) break;
        }
    }
    return 0;
}
