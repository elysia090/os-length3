#include <stdint.h>

/* Modular addition, from the Bit Hacks lecture of MIT 6.172, Performance
 * Engineering of Software Systems: (x + y) mod n, for operands already
 * reduced, is the sum with n taken off it again if it reached n -- and the
 * lecture's version does that without a branch.
 *
 * The two operands arrive as the high and low halves of one word. */
uint32_t mod_add_u32(uint64_t ab)
{
    uint32_t a = (uint32_t)(ab >> 32);
    uint32_t b = (uint32_t)ab;
    uint64_t s = (uint64_t)a + (uint64_t)b;

    if (s >= 0xFFFFFFFBu) s -= 0xFFFFFFFBu;   /* 2^32 - 5, the largest u32 prime */
    return (uint32_t)s;
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
                print_hex64((uint64_t)mod_add_u32((uint64_t)x));
                putchar('\n');
            }
            x = 0;
            seen = 0;
            if (c < 0) break;
        }
    }
    return 0;
}
