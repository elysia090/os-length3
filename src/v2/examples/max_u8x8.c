#include <stdint.h>

/* The largest of eight bytes packed in one 64-bit word.
 *
 * The word-parallel form compares all eight lanes at once with ordinary
 * 64-bit arithmetic and keeps the winners, halving the number of candidates
 * each round. Stated here as the loop it replaces. */
uint8_t max_u8x8(uint64_t v)
{
    uint8_t best = 0;

    for (unsigned i = 0; i < 8; ++i) {
        uint8_t lane = (uint8_t)(v >> (8 * i));
        if (lane > best) best = lane;
    }
    return best;
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
                print_hex64((uint64_t)max_u8x8((uint64_t)x));
                putchar('\n');
            }
            x = 0;
            seen = 0;
            if (c < 0) break;
        }
    }
    return 0;
}
