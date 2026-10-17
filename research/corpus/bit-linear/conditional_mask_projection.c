#include <stdint.h>

uint32_t conditional_mask_projection(uint32_t x)
{
    uint32_t result = x & 3u;

    if (x & (1u << 3))
        result |= 0x29ffcu;
    if (x & (1u << 4))
        result |= 0x8c54u;
    if (x & (1u << 5))
        result |= 0xa8u;
    if (x & (1u << 6))
        result |= 0x800u;
    if (x & (1u << 7))
        result |= 0x1000u;
    if (x & (1u << 8))
        result |= 0x2000u;
    if (x & (1u << 9))
        result |= 0x4000u;
    if (x & (1u << 10))
        result |= 0x100u;
    if (x & (1u << 12))
        result |= 0x20000u;
    if (x & (1u << 13))
        result |= 0x8004u;
    if (x & (1u << 16))
        result |= 0x40000u;

    return result;
}
