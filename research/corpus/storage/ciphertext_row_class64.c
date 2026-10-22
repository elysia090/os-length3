#include <stdint.h>

/* Smallest 64-byte capacity class containing an encoded row.
 * The resulting padding is always in the closed interval [0, 63]. */
uint16_t ciphertext_row_class64(uint16_t encoded_bytes)
{
    return (uint16_t)(((uint32_t)encoded_bytes + 63u) >> 6);
}
