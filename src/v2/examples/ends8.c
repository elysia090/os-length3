#include <stdint.h>

/* Run ends: a set bit whose right neighbour is clear.  The mirror of starts8,
 * and it lowers to the mirror sequence.
 * lanecode.h: lc_ends — x & ~(x >> 1) */
uint64_t ends8(uint8_t m)
{
    uint64_t x = m;

    return x & ~(x >> 1);
}
