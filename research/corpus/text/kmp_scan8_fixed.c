#include <stdint.h>
/* Algorithms, 4th Edition, KMP: the automaton state after eight text bits for
 * fixed pattern 1011. State is how much of the pattern currently matches. */
uint8_t kmp_scan8_fixed(uint8_t text)
{
    uint8_t state = 0;
    for (int i = 7; i >= 0; --i) {
        uint8_t bit = (uint8_t)((text >> i) & 1u);
        if (state == 0) state = bit ? 1u : 0u;
        else if (state == 1) state = bit ? 1u : 2u;
        else if (state == 2) state = bit ? 3u : 0u;
        else if (state == 3) state = bit ? 4u : 2u;
        else state = bit ? 1u : 2u;
    }
    return state;
}
