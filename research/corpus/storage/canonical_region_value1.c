#include <stdint.h>

/* One coordinate of the right-biased Canonical Region union.
 *
 * Singleton reads make coordinates independent, so the eight-byte form is
 * exactly eight parallel copies of this function. */
uint8_t canonical_region_value1(
    uint8_t previous,
    uint8_t written_value,
    _Bool written)
{
    return written ? written_value : previous;
}
