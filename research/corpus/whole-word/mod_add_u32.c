#include <stdint.h>

/* MIT 6.172 Lecture 3: modular addition by a conditional subtraction. The
 * operands are assumed already reduced; what the function computes is `a + b`,
 * minus the modulus when the sum reached it, and nothing else. */
uint32_t mod_add_u32(uint64_t ab)
{
    uint32_t a = (uint32_t)(ab >> 32);
    uint32_t b = (uint32_t)ab;
    uint64_t s = (uint64_t)a + (uint64_t)b;

    if (s >= 0xFFFFFFFBu) s -= 0xFFFFFFFBu;   /* 2^32 - 5, the largest u32 prime */
    return (uint32_t)s;
}
