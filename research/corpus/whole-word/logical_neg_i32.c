#include <stdint.h>

/* Adapted from CS:APP Data Lab logicalNeg: return 1 exactly when x is zero. */
uint32_t logical_neg_i32(uint32_t x)
{
    return x == 0u ? 1u : 0u;
}
