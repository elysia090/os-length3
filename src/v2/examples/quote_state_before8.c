#include <stdint.h>

/* Exclusive running parity expanded to 0x00/0xFF byte lanes: whether a CSV
 * scanner is inside quotes as it enters each lane. */
uint64_t quote_state_before8(uint8_t m)
{
    uint64_t r = 0;

    for (unsigned i = 0; i < 8; ++i) {
        unsigned p = __builtin_popcount(m & ((1u << i) - 1)) & 1;
        r |= (uint64_t)(p * 0xFF) << (8 * i);
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
                print_hex64((uint64_t)quote_state_before8((uint8_t)x));
                putchar('\n');
            }
            x = 0;
            seen = 0;
            if (c < 0) break;
        }
    }
    return 0;
}
