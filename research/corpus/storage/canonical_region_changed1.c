#include <stdint.h>

/* The only base observation needed when a coordinate is newly written.
 * Equality with the immutable base deletes the coordinate from the persistent
 * difference domain. */
_Bool canonical_region_changed1(uint8_t base, uint8_t written_value)
{
    return written_value != base;
}
