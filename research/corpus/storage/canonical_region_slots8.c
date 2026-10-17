#include <stdint.h>

/* Local one-based direct slots for eight persistent-cut coordinates.
 *
 * Zero denotes the immutable base.  A nonzero byte is one plus the number of
 * dirty coordinates before it in this block.  The page-wide address is this
 * local slot plus the exclusive prefix of the preceding block counts. */
uint64_t canonical_region_slots8(uint8_t dirty)
{
    uint64_t slots = 0;

    for (unsigned i = 0; i < 8; ++i) {
        if ((dirty >> i) & 1) {
            uint8_t before = (uint8_t)__builtin_popcount(
                dirty & ((1u << i) - 1));
            slots |= (uint64_t)(before + 1) << (8 * i);
        }
    }
    return slots;
}
