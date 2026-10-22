#include <stdint.h>

/* Mark the first byte and each byte that differs from its predecessor.
 * These are the exact rows retained by byte-run compression.  Masking every
 * lane to seven bits before adding 0x7f prevents carry between byte lanes. */
uint64_t rle_run_starts8(uint64_t x)
{
    const uint64_t low7 = 0x7f7f7f7f7f7f7f7full;
    const uint64_t high = 0x8080808080808080ull;
    uint64_t difference = x ^ (x << 8);
    uint64_t zero = ~(((difference & low7) + low7) | difference) & high;

    return ((~zero) & high) | 0x80ull;
}
