#include <stdint.h>

/* Algorithms, 4th Edition, Rabin-Karp: one rolling-hash update. The hash
 * moves up by the radix, the character coming in is added, and the whole thing
 * is reduced modulo the prime.  The running hash is the high byte of the
 * input and the character is the low byte. */
uint16_t rabin_karp_roll(uint16_t hc)
{
    uint32_t h = (uint32_t)(hc >> 8);
    uint32_t c = (uint32_t)(hc & 0xFFu);

    return (uint16_t)((h * 256u + c) % 251u);
}
