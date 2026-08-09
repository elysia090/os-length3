#include <stdint.h>

/* One step of the Rabin-Karp rolling hash, from section 5.3 of Sedgewick and
 * Wayne's Algorithms, Fourth Edition: the running hash moves up by the radix,
 * the character coming in is added, and the result is taken modulo a prime.
 *
 * The running hash is the high byte of the input and the character is the low
 * byte, so the radix is 256. */
uint16_t rabin_karp_roll(uint16_t hc)
{
    uint32_t h = (uint32_t)(hc >> 8);
    uint32_t c = (uint32_t)(hc & 0xFFu);

    return (uint16_t)((h * 256u + c) % 251u);
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
                print_hex64((uint64_t)rabin_karp_roll((uint16_t)x));
                putchar('\n');
            }
            x = 0;
            seen = 0;
            if (c < 0) break;
        }
    }
    return 0;
}
