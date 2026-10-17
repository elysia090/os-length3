#include <stdint.h>

/* Exclusive prefix sums of eight byte-lane counts, in place.
 * lanecode.h: lc_block_offsets8 — counts * ONES
 * Requires every prefix to fit in one byte. */
uint64_t block_offsets8(uint64_t counts)
{
    uint64_t r = 0;
    uint64_t acc = 0;

    for (unsigned i = 0; i < 8; ++i) {
        r |= (acc & 0xFF) << (8 * i);
        acc += (counts >> (8 * i)) & 0xFF;
    }

    return r;
}
