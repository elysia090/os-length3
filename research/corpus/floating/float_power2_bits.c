#include <stdint.h>
/* Adapted from CS:APP Data Lab floatPower2, with x read as a signed byte. */
uint32_t float_power2_bits(uint8_t x)
{
    int32_t e = (int32_t)(int8_t)x + 127;
    if (e <= 0) return 0u;
    if (e >= 255) return 0x7F800000u;
    return (uint32_t)e << 23;
}
