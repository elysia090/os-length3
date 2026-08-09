#include <stdint.h>

/* Spread 16 bits into the even positions of a 32-bit word -- the dilation
 * step of a Morton, or Z-order, curve.  Each input bit moves to a fixed
 * output position and nothing is combined, so how it is best computed depends
 * entirely on what the machine can do. */
uint32_t morton_dilate16(uint16_t x)
{
    uint32_t r = 0;

    for (unsigned i = 0; i < 16; ++i)
        if ((x >> i) & 1)
            r |= 1u << (2 * i);

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
                print_hex64((uint64_t)morton_dilate16((uint16_t)x));
                putchar('\n');
            }
            x = 0;
            seen = 0;
            if (c < 0) break;
        }
    }
    return 0;
}
