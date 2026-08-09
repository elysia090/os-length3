#include <stdint.h>

/* The counting pass of key-indexed counting on its own -- section 5.1 of
 * Sedgewick and Wayne's Algorithms, Fourth Edition.
 *
 * Sixteen two-bit keys in one word, and the four counts they produce, packed
 * one per byte. Four independent answers in four fields of one result. */
uint32_t histogram4_u2x16(uint32_t v)
{
    uint32_t out = 0;

    for (unsigned i = 0; i < 16; ++i)
        out += (uint32_t)1 << (8 * ((v >> (2 * i)) & 3u));
    return out;
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
                print_hex64((uint64_t)histogram4_u2x16((uint32_t)x));
                putchar('\n');
            }
            x = 0;
            seen = 0;
            if (c < 0) break;
        }
    }
    return 0;
}
