#include <stdint.h>

/* Adapted from CS:APP Data Lab isLessOrEqual: compare two signed 32-bit values
 * stored in the high and low halves of one word.
 *
 * A comparison between two parts of a word, not within a lane: the lane
 * predicates in lanecode.h answer eight of these at once and none of them
 * answers this one. */
uint32_t is_less_or_equal_i32(uint64_t ab)
{
    int32_t a = (int32_t)(uint32_t)(ab >> 32);
    int32_t b = (int32_t)(uint32_t)ab;

    return a <= b ? 1u : 0u;
}
