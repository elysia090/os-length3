#include <stdint.h>

/* Inclusive prefix XOR over 64 bits: multiplication by (1+x)^-1 in GF(2)[x].
 * lanecode.h: lc_prefix_xor64 — one CLMUL by all-ones */
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
