#include <stdint.h>
/* Algorithms, 4th Edition, key-indexed counting: sort eight 2-bit keys. */
uint16_t counting_sort8_u2(uint16_t v)
{
    int count[4] = {0, 0, 0, 0};
    uint16_t out = 0;
    int at = 0;

    for (int i = 0; i < 8; ++i) count[(v >> (2 * i)) & 3u] += 1;
    for (int key = 0; key < 4; ++key)
        for (int n = 0; n < count[key]; ++n)
            out |= (uint16_t)((uint16_t)key << (2 * at++));
    return out;
}
