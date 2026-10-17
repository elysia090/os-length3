#include <stdint.h>

/*
 * A small quotient that once escaped only through the Wasm input path and
 * became a 256-entry table.  NEG must survive stack recovery, and the two
 * adjacent XOR constants must become one physical operation.
 */
uint64_t xor_residual8(uint8_t x)
{
    uint64_t a = -(uint64_t)x;
    uint64_t b = a - 7ull;
    uint64_t c = b ^ (uint64_t)x;
    c ^= 0x419BB78768F0D0E3ull;
    return c ^ 0xB4FF7F7BAC3C7F34ull;
}
