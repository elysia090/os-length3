#include <stdint.h>

/* MIT 6.172 Lecture 3: select the smaller of two signed 32-bit values. The
 * operands occupy the high and low halves of the input word. */
uint32_t min_i32(uint64_t ab)
{
    int32_t a = (int32_t)(uint32_t)(ab >> 32);
    int32_t b = (int32_t)(uint32_t)ab;

    return (uint32_t)(a < b ? a : b);
}
