#include <stdint.h>

/* The Knuth-Morris-Pratt automaton, from section 5.3 of Sedgewick and Wayne's
 * Algorithms, Fourth Edition: the state is how much of the pattern currently
 * matches, and each character of text advances it.
 *
 * Eight bits of text against the fixed pattern 1011, answering with the state
 * the automaton ends in. */
uint8_t kmp_scan8_fixed(uint8_t text)
{
    uint8_t state = 0;
    for (int i = 7; i >= 0; --i) {
        uint8_t bit = (uint8_t)((text >> i) & 1u);
        if (state == 0) state = bit ? 1u : 0u;
        else if (state == 1) state = bit ? 1u : 2u;
        else if (state == 2) state = bit ? 3u : 0u;
        else if (state == 3) state = bit ? 4u : 2u;
        else state = bit ? 1u : 2u;
    }
    return state;
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
                print_hex64((uint64_t)kmp_scan8_fixed((uint8_t)x));
                putchar('\n');
            }
            x = 0;
            seen = 0;
            if (c < 0) break;
        }
    }
    return 0;
}
