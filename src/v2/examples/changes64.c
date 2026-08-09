#include <stdint.h>

/* Bit positions where the value differs from its left neighbour.
 * lanecode.h: lc_changes — x ^ (x << 1), which is also CLMUL by 3 */
uint64_t changes64(uint64_t x)
{
    return x ^ (x << 1);
}
