#include <stdint.h>

/* Return the IEEE 754 binary64 encoding of 2^exponent.
 *
 * A normal result is only a biased exponent field. A subnormal power of two
 * is only one fraction bit. Values outside the binary64 exponent region map
 * directly to infinity or zero, so no floating value needs to be built and
 * decoded on the internal path. */
uint64_t binary64_power2_bits(int32_t exponent)
{
    if (exponent > 1023) return UINT64_C(0x7ff0000000000000);
    if (exponent < -1074) return 0;
    if (exponent >= -1022)
        return (uint64_t)(exponent + 1023) << 52;
    return UINT64_C(1) << (uint32_t)(exponent + 1074);
}
