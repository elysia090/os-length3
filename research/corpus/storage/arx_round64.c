#include <stdint.h>

/* One reversible fixed-key 32-bit-word add-rotate-xor lane.  This isolates the
 * constant-time arithmetic shape used inside established ciphers; it is not
 * encryption or authentication by itself. */
uint64_t arx_round64(uint64_t state)
{
    uint32_t x = (uint32_t)(state >> 32);
    uint32_t y = (uint32_t)state;

    x = ((x >> 8) | (x << 24)) + y;
    x ^= 0x9e3779b9u;
    y = ((y << 3) | (y >> 29)) ^ x;
    return ((uint64_t)x << 32) | y;
}
