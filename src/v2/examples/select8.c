#include <stdint.h>

/* Indices of the set bits, packed into byte lanes.  Needs a data-dependent
 * permutation, so the normalized program ends in PERM_DYN. */
uint64_t select8(uint8_t m)
{
    uint64_t r = 0;
    unsigned j = 0;

    for (unsigned i = 0; i < 8; ++i)
        if ((m >> i) & 1)
            r |= (uint64_t)i << (8 * j++);

    return r;
}
