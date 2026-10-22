#include <stdint.h>

/* Multiply two bytes in GF(2^8), reduced by x^8+x^4+x^3+x^2+1.
 * The low input byte is the first coefficient vector and the high byte is the
 * second.  All eight products are exposed at once; there is no table lookup
 * or data-dependent branch. */
uint8_t erasure_gf256_mul(uint16_t packed)
{
    uint32_t a0 = (uint8_t)packed;
    uint32_t b = packed >> 8;
    uint32_t a1 = ((a0 << 1) & 255u) ^ ((0u - (a0 >> 7)) & 0x1du);
    uint32_t a2 = ((a1 << 1) & 255u) ^ ((0u - (a1 >> 7)) & 0x1du);
    uint32_t a3 = ((a2 << 1) & 255u) ^ ((0u - (a2 >> 7)) & 0x1du);
    uint32_t a4 = ((a3 << 1) & 255u) ^ ((0u - (a3 >> 7)) & 0x1du);
    uint32_t a5 = ((a4 << 1) & 255u) ^ ((0u - (a4 >> 7)) & 0x1du);
    uint32_t a6 = ((a5 << 1) & 255u) ^ ((0u - (a5 >> 7)) & 0x1du);
    uint32_t a7 = ((a6 << 1) & 255u) ^ ((0u - (a6 >> 7)) & 0x1du);

    return (uint8_t)(
        (a0 & (0u - ((b >> 0) & 1u))) ^
        (a1 & (0u - ((b >> 1) & 1u))) ^
        (a2 & (0u - ((b >> 2) & 1u))) ^
        (a3 & (0u - ((b >> 3) & 1u))) ^
        (a4 & (0u - ((b >> 4) & 1u))) ^
        (a5 & (0u - ((b >> 5) & 1u))) ^
        (a6 & (0u - ((b >> 6) & 1u))) ^
        (a7 & (0u - ((b >> 7) & 1u))));
}
