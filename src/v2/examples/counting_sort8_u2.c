#include <stdint.h>

/* Key-indexed counting, from section 5.1 of Sedgewick and Wayne's Algorithms,
 * Fourth Edition: count how many keys take each value, then write the values
 * back out in order.
 *
 * Eight two-bit keys packed in one word, sorted in place. */
uint16_t counting_sort8_u2(uint16_t v)
{
    int count[4] = {0, 0, 0, 0};
    uint16_t out = 0;
    int at = 0;

    for (int i = 0; i < 8; ++i) count[(v >> (2 * i)) & 3u] += 1;
    for (int key = 0; key < 4; ++key)
        for (int n = 0; n < count[key]; ++n)
            out |= (uint16_t)((uint16_t)key << (2 * at++));
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
                print_hex64((uint64_t)counting_sort8_u2((uint16_t)x));
                putchar('\n');
            }
            x = 0;
            seen = 0;
            if (c < 0) break;
        }
    }
    return 0;
}
