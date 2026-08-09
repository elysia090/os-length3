#include <stdint.h>

/* CS:APP Data Lab, bang — `!x` without using `!`.  One bit of output, and the
 * whole 32-bit word decides it. */
uint32_t logical_neg_i32(uint32_t x)
{
    return x == 0u ? 1u : 0u;
}
