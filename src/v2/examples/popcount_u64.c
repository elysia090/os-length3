#include <stdint.h>

/* MIT 6.172 — the population count, written as the loop nobody ships. */
uint32_t popcount_u64(uint64_t x)
{
    uint32_t n = 0;

    for (unsigned i = 0; i < 64; ++i)
        n += (uint32_t)((x >> i) & 1u);
    return n;
}
