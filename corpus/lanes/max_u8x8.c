#include <stdint.h>

/* Return the largest of eight unsigned bytes packed in one word. */
uint8_t max_u8x8(uint64_t v)
{
    uint8_t best = 0;

    for (unsigned i = 0; i < 8; ++i) {
        uint8_t lane = (uint8_t)(v >> (8 * i));
        if (lane > best) best = lane;
    }
    return best;
}
