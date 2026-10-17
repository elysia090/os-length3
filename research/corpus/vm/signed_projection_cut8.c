#include <stdint.h>

/*
 * Differential-fuzzer reduction for a pure machine slice.  All intermediates
 * look live in the source graph, but substitution leaves one signed affine
 * projection.  The C compiler currently exposes the three-operation form;
 * the common semantic solver must eventually derive it from either listing.
 */
uint64_t signed_projection_cut8(uint8_t x)
{
    uint64_t t1 = (uint64_t)x << 28;
    uint64_t t2 = t1 | (uint64_t)x;
    uint64_t t3 = t2 << 36;
    uint64_t t4 = t3 | 8ull;
    uint64_t t5 = t4 - t1;
    uint64_t t6 = t5 + t2;
    uint64_t t7 = t6 << 47;
    uint64_t t8 = t7 ^ 7ull;
    uint64_t t9 = t8 ? (uint64_t)__builtin_ctzll(t8) : 64;
    uint64_t t10 = t9 ^ t7;
    uint64_t t11 = t10 << 8;
    return (uint64_t)((int64_t)t11 >> 49);
}
