#include <stdint.h>

/* Multiply eight independent GF(2^8) coefficients by 0x1d. */
uint64_t erasure_gf256_mul8_const(uint64_t a0)
{
    const uint64_t low = 0xfefefefefefefefeull;
    const uint64_t high = 0x0101010101010101ull;
    uint64_t a1 = ((a0 << 1) & low) ^ (((a0 >> 7) & high) * 0x1du);
    uint64_t a2 = ((a1 << 1) & low) ^ (((a1 >> 7) & high) * 0x1du);
    uint64_t a3 = ((a2 << 1) & low) ^ (((a2 >> 7) & high) * 0x1du);
    uint64_t a4 = ((a3 << 1) & low) ^ (((a3 >> 7) & high) * 0x1du);

    return a0 ^ a2 ^ a3 ^ a4;
}
