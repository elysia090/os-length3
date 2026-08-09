#include <stdint.h>

/* MIT 6.172 — the branchless minimum of two signed 32-bit values, packed as
 * the high and low halves of one word.  What the lecture is about is that the
 * branch is avoidable; what QM has to find is which of the two words the
 * comparison selects. */
uint32_t min_i32(uint64_t ab)
{
    int32_t a = (int32_t)(uint32_t)(ab >> 32);
    int32_t b = (int32_t)(uint32_t)ab;

    return (uint32_t)(a < b ? a : b);
}
