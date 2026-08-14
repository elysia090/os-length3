#include <stdint.h>

/*
 * A constant-offset GF(2)-affine reduction.  Substitution cancels the two
 * repeated x terms and the zero arithmetic, leaving a four-operation linear
 * map plus its forced XOR constant.
 */
uint64_t gf2_affine_cut8(uint8_t x)
{
    uint64_t a = (uint64_t)x ^ 0xFFFFFFFFull;
    uint64_t b = a - (uint64_t)x;
    uint64_t c = b & 0x101ull;
    uint64_t d = c ^ (uint64_t)x;
    uint64_t e = d ^ a;
    uint64_t f = e ^ (uint64_t)x;
    uint64_t g = ~f & b;
    uint64_t h = (uint64_t)((int64_t)g >> 42);
    return ~h & d;
}
