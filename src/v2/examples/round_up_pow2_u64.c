#include <stdint.h>

/* MIT 6.172 — the smallest power of two that is not below x.  Zero is not
 * rounded up to anything, and a value above 2^63 has nothing to round up to,
 * so both answer zero. */
uint64_t round_up_pow2_u64(uint64_t x)
{
    uint64_t n = 0;

    if (x != 0) {
        n = 1;
        for (unsigned i = 0; i < 64; ++i)
            if (n < x) n <<= 1;
    }
    return n;
}
