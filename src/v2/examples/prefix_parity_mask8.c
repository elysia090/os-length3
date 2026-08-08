#include <stdint.h>

/* Inclusive running parity, expanded to 0x00/0xFF byte lanes.
 * lanecode.h: lc_prefix_parity_mask8 — PDEP then CLMUL by all-ones */
uint64_t prefix_parity_mask8(uint8_t m)
{
    uint64_t r = 0;
    unsigned p = 0;

    for (unsigned i = 0; i < 8; ++i) {
        p ^= (m >> i) & 1;
        r |= (uint64_t)(p * 0xFF) << (8 * i);
    }

    return r;
}
