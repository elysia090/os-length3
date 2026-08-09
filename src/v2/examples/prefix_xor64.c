#include <stdint.h>

/* Inclusive prefix XOR over 64 bits: bit i becomes the parity of bits 0..i.
 * Over GF(2)[x] that is multiplication by the all-ones polynomial, which a
 * carry-less multiply does in one instruction. */
uint64_t prefix_xor64(uint64_t x)
{
    uint64_t r = 0;
    uint64_t p = 0;

    for (unsigned i = 0; i < 64; ++i) {
        p ^= (x >> i) & 1;
        r |= p << i;
    }

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
                print_hex64((uint64_t)prefix_xor64((uint64_t)x));
                putchar('\n');
            }
            x = 0;
            seen = 0;
            if (c < 0) break;
        }
    }
    return 0;
}
