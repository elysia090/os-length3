#include <stdint.h>

/* The common successor is the current rank plus the signed relative target.
 * A set support bit selects an exceptional code: zero means unresolved, the
 * high bit names an absolute rank, and every other code is a zigzag-encoded
 * signed correction. */
uint32_t predicted_successor(uint32_t state, int32_t relative_target,
                             uint32_t supported, uint32_t code)
{
    int64_t predicted = (int64_t)state + relative_target;
    if (!(supported & 1u))
        return (uint32_t)predicted;
    if (!code)
        return UINT32_MAX;
    if (code & 0x80000000u)
        return code & 0x7fffffffu;
    int32_t correction = (int32_t)((code >> 1)
                         ^ (0u - (code & 1u)));
    return (uint32_t)(predicted + correction);
}
