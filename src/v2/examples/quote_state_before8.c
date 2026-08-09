#include <stdint.h>

/* Exclusive running parity expanded to 0x00/0xFF byte lanes: the quote state
 * entering each lane.  Normalizes to a carry-less convolution. */
uint64_t quote_state_before8(uint8_t m)
{
    uint64_t r = 0;

    for (unsigned i = 0; i < 8; ++i) {
        unsigned p = __builtin_popcount(m & ((1u << i) - 1)) & 1;
        r |= (uint64_t)(p * 0xFF) << (8 * i);
    }

    return r;
}
