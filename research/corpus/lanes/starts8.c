#include <stdint.h>

/* Run starts: a set bit whose left neighbour is clear.
 * lanecode.h: lc_starts — x & ~(x << 1) */
uint64_t starts8(uint8_t m)
{
    uint64_t x = m;

    return x & ~(x << 1);
}
