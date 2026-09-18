#include <stdint.h>

/* Exclusive prefix of four four-bit block counts into byte lanes.
 * Every preceding sum is at most 3 * 15, so it cannot carry out of a lane. */
uint32_t canonical_region_block_offsets4(uint16_t counts)
{
    uint32_t result = 0;
    uint32_t preceding = 0;

    for (unsigned block = 0; block < 4; ++block) {
        result |= preceding << (8 * block);
        preceding += (counts >> (4 * block)) & 15;
    }
    return result;
}
