#include <stdint.h>

/* For an ordered family of at most 255 fixed thresholds, rank is the number
 * of thresholds already passed.  Query j is true exactly when rank > j.
 * Packing both bytes gives a dense 16-bit differential-test domain. */
uint8_t rank_token_query8(uint16_t rank_and_query)
{
    uint8_t rank = (uint8_t)rank_and_query;
    uint8_t query = (uint8_t)(rank_and_query >> 8);
    return (uint8_t)(rank > query);
}
