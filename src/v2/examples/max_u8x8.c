#include <stdint.h>

/* MIT 6.172 — the largest of eight bytes packed in a word.  A reduction: the
 * output is one lane wide however wide the input is, which no deposit, no
 * convolution and no lane predicate can produce. */
uint8_t max_u8x8(uint64_t v)
{
    uint8_t best = 0;

    for (unsigned i = 0; i < 8; ++i) {
        uint8_t lane = (uint8_t)(v >> (8 * i));
        if (lane > best) best = lane;
    }
    return best;
}
