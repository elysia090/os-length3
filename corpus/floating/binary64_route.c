#include <stdint.h>

/* Produce the exceptional-path address used by binary64 arithmetic.
 *
 * The common finite-normal region is address zero. The five boundary classes
 * are subnormal, zero, infinity, quiet NaN, and signaling NaN. The original
 * word remains the value state; this small address only selects the residual,
 * so a chain can classify once and retain the word in its integer/f64 lane
 * until the architectural boundary. */
/* fraction_flags bit 0 says that the fraction is nonzero; bit 1 is the quiet
 * bit. Keeping these fields beside the value word lets a scalar slice reuse
 * this route without decoding the same word for every operation. */
uint32_t binary64_route_fields(uint32_t exponent, uint32_t fraction_flags)
{
    if (exponent - 1u < 0x7feu) return 0u;       /* finite normal */
    if (exponent == 0u) return fraction_flags & 1u ? 1u : 2u;
    if (!(fraction_flags & 1u)) return 3u;
    return fraction_flags & 2u ? 4u : 5u;
}

uint32_t binary64_route(uint64_t bits)
{
    uint32_t exponent = (uint32_t)(bits >> 52) & 0x7ffu;
    uint64_t fraction = bits & UINT64_C(0x000fffffffffffff);
    uint32_t fraction_flags = (fraction != 0u)
        | (uint32_t)((bits >> 50) & 2u);
    return binary64_route_fields(exponent, fraction_flags);
}
