#include <stdint.h>

/* Four pending bytes and their live extent form one line-sized output value.
 * Bytes outside the extent are unobservable and therefore masked away. */
uint32_t console_line_cut(uint64_t bytes_and_extent)
{
    uint32_t bytes = (uint32_t)bytes_and_extent;
    uint32_t extent = (uint32_t)(bytes_and_extent >> 32) & 3u;
    uint32_t bits = (extent + 1u) * 8u;

    return bits == 32u ? bytes : bytes & ((1u << bits) - 1u);
}
